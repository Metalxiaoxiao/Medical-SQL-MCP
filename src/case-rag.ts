import * as fs from 'fs';
import * as path from 'path';
import { getEmbedding } from './llm';
import { log } from './logger';
import { getElasticsearchAdapter } from './elasticsearch';
import { embeddingRateLimiter } from './rate-limiter';

const CASE_CACHE_FILE = path.resolve(process.cwd(), 'case-embeddings-cache.json');
const INDEXING_STATUS_FILE = path.resolve(process.cwd(), 'case-indexing-status.json');

interface CaseEmbeddingEntry {
  caseId: string;
  index: string;
  text: string;
  embedding: number[];
  metadata: {
    patientId?: string;
    visitId?: string;
    surgeryType?: string;
    surgeon?: string;
    dataSource?: string;
    surgeryRecord?: string;
    [key: string]: any;
  };
  updatedAt: string;
}

interface IndexingStatus {
  isIndexing: boolean;
  totalCases: number;
  indexedCases: number;
  failedCases: number;
  startTime?: string;
  endTime?: string;
  currentIndex?: string;
  lastError?: string;
}

export class CaseRAGSystem {
  private index: CaseEmbeddingEntry[] = [];
  private indexingStatus: IndexingStatus = {
    isIndexing: false,
    totalCases: 0,
    indexedCases: 0,
    failedCases: 0
  };
  private elasticsearch = getElasticsearchAdapter();
  private cacheSaveTimeout: NodeJS.Timeout | null = null;

  constructor() {
    this.loadCache();
    this.loadIndexingStatus();
    this.fixIndexingStatus();
  }

  private loadCache() {
    if (fs.existsSync(CASE_CACHE_FILE)) {
      try {
        this.index = JSON.parse(fs.readFileSync(CASE_CACHE_FILE, 'utf-8'));
        log.info(`Loaded ${this.index.length} case embeddings from cache`);
      } catch (e) {
        console.error('Failed to load case embeddings cache', e);
        this.index = [];
      }
    }
  }

  private saveCache() {
    fs.writeFileSync(CASE_CACHE_FILE, JSON.stringify(this.index, null, 2));
  }

  private loadIndexingStatus() {
    if (fs.existsSync(INDEXING_STATUS_FILE)) {
      try {
        this.indexingStatus = JSON.parse(fs.readFileSync(INDEXING_STATUS_FILE, 'utf-8'));
      } catch (e) {
        console.error('Failed to load indexing status', e);
      }
    }
  }

  private saveIndexingStatus() {
    fs.writeFileSync(INDEXING_STATUS_FILE, JSON.stringify(this.indexingStatus, null, 2));
  }

  /**
   * 修复索引状态
   * 如果isIndexing为true但索引实际上没有运行，则重置状态
   */
  private fixIndexingStatus(): void {
    if (this.indexingStatus.isIndexing) {
      // 检查是否有有效的开始时间
      const hasValidStartTime = this.indexingStatus.startTime && 
        new Date(this.indexingStatus.startTime).getTime() > 0;
      
      // 检查是否已经运行了很长时间（超过24小时）
      const isStale = hasValidStartTime && 
        (Date.now() - new Date(this.indexingStatus.startTime!).getTime()) > 24 * 60 * 60 * 1000;
      
      // 检查是否有进度
      const hasProgress = this.indexingStatus.indexedCases > 0 || 
                         this.indexingStatus.failedCases > 0;
      
      // 如果没有有效的开始时间、状态已过期、或者没有进度，则重置状态
      if (!hasValidStartTime || isStale || !hasProgress) {
        log.info('Fixing stale indexing status...');
        this.indexingStatus = {
          isIndexing: false,
          totalCases: this.indexingStatus.totalCases,
          indexedCases: this.indexingStatus.indexedCases,
          failedCases: this.indexingStatus.failedCases
        };
        this.saveIndexingStatus();
        log.info('Indexing status fixed');
      }
    }
  }

  private caseToText(caseData: any): string {
    // 构建病例的文本表示，用于生成嵌入向量
    const parts: string[] = [];
    
    if (caseData.手术记录) parts.push(`手术记录: ${caseData.手术记录}`);
    if (caseData.手术类型) parts.push(`手术类型: ${caseData.手术类型}`);
    if (caseData.手术名称) parts.push(`手术名称: ${caseData.手术名称}`);
    if (caseData.手术医师) parts.push(`手术医师: ${caseData.手术医师}`);
    if (caseData.麻醉医师) parts.push(`麻醉医师: ${caseData.麻醉医师}`);
    if (caseData.麻醉方式) parts.push(`麻醉方式: ${caseData.麻醉方式}`);
    if (caseData.数据来源) parts.push(`数据来源: ${caseData.数据来源}`);
    if (caseData.唯一ID号) parts.push(`患者ID: ${caseData.唯一ID号}`);
    if (caseData.就诊流水号) parts.push(`就诊流水号: ${caseData.就诊流水号}`);
    
    return parts.join('\n');
  }

  private extractMetadata(caseData: any): any {
    return {
      patientId: caseData.唯一ID号,
      visitId: caseData.就诊流水号,
      surgeryType: caseData.手术类型,
      surgeon: caseData.手术医师,
      dataSource: caseData.数据来源,
      surgeryRecord: caseData.手术记录?.substring(0, 500), // 截取前500字符
      ...caseData
    };
  }

  /**
   * 检查病例是否已经嵌入
   */
  private isCaseAlreadyEmbedded(caseId: string, indexName: string): boolean {
    return this.index.some(e => e.caseId === caseId && e.index === indexName);
  }

  /**
   * 异步处理单个病例的嵌入
   */
  private async processCaseEmbedding(
    hit: any, 
    indexName: string, 
    batchIndex: number,
    totalInBatch: number
  ): Promise<void> {
    const caseId = hit._id;
    
    try {
      // 检查是否已经嵌入
      if (this.isCaseAlreadyEmbedded(caseId, indexName)) {
        log.info(`Case ${caseId} already embedded, skipping`);
        return;
      }

      const caseData = hit._source;
      const text = this.caseToText(caseData);
      const metadata = this.extractMetadata(caseData);

      // 生成嵌入向量（带重试机制）
      log.info(`[${batchIndex}/${totalInBatch}] Generating embedding for case ${caseId}...`);
      const embedding = await this.getEmbeddingWithRetry(text, 3);

      // 添加到索引
      this.index.push({
        caseId,
        index: indexName,
        text,
        embedding,
        metadata,
        updatedAt: new Date().toISOString()
      });

      // 异步保存缓存（不等待）
      this.saveCacheAsync();

      this.indexingStatus.indexedCases++;
      this.saveIndexingStatus();

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`Failed to process case ${caseId}:`, { 
        caseId,
        error: errorMessage 
      });
      this.indexingStatus.failedCases++;
      this.saveIndexingStatus();
    }
  }

  /**
   * 异步保存缓存
   */
  private saveCacheAsync(): void {
    // 使用setTimeout实现异步保存，避免阻塞主线程
    if (!this.cacheSaveTimeout) {
      this.cacheSaveTimeout = setTimeout(() => {
        this.saveCache();
        this.cacheSaveTimeout = null;
      }, 1000); // 延迟1秒保存，避免频繁写入
    }
  }

  /**
   * 清理缓存保存定时器
   */
  private cleanupCacheSaveTimeout(): void {
    if (this.cacheSaveTimeout) {
      clearTimeout(this.cacheSaveTimeout);
      this.cacheSaveTimeout = null;
    }
  }

  /**
   * 报告进度
   */
  private reportProgress(processed: number, total: number): void {
    const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;
    
    // 每10%或每100个病例报告一次进度
    if (percentage % 10 === 0 || processed % 100 === 0) {
      log.info(`Indexing progress: ${processed}/${total} (${percentage}%)`);
      
      // 每500个病例报告一次速率限制状态
      if (processed % 500 === 0) {
        this.reportRateLimitStatus();
      }
    }
  }

  /**
   * 报告速率限制状态
   */
  private reportRateLimitStatus(): void {
    try {
      const status = embeddingRateLimiter.getStatus();
      log.info(`Rate limit status: ${status.currentRequests}/${status.maxRequests} requests in last ${status.timeWindow/1000}s (${status.utilization.toFixed(1)}% utilization)`);
    } catch (error) {
      log.info('Failed to get rate limit status:', error);
    }
  }

  /**
   * 带重试和速率限制的嵌入生成
   */
  private async getEmbeddingWithRetry(text: string, maxRetries: number = 3): Promise<number[]> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // 应用速率限制
        await embeddingRateLimiter.waitForNextRequest();
        
        // 每100个请求报告一次速率限制状态
        if (attempt === 1) {
          const status = embeddingRateLimiter.getStatus();
          if (this.indexingStatus.indexedCases % 100 === 0) {
            log.info(`Rate limiter status: ${status.currentRequests}/${status.maxRequests} requests (${status.utilization.toFixed(1)}% utilization)`);
          }
        }
        
        return await getEmbedding(text);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // 检查是否是速率限制错误
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('rate limit') || errorMessage.includes('429') || errorMessage.includes('too many requests')) {
          log.warn(`Rate limit hit, increasing delay...`);
          const delay = Math.pow(2, attempt) * 5000; // 更长的指数退避
          log.warn(`Embedding generation rate limited (attempt ${attempt}/${maxRetries}), waiting ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          
          // 重置速率限制器状态
          embeddingRateLimiter.reset();
          continue;
        }
        
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // 指数退避
          log.warn(`Embedding generation failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw lastError || new Error('Embedding generation failed after all retries');
  }

  /**
   * 异步索引所有病例数据
   * @param indices 要索引的索引列表，默认为 ['surgery_records']
   * @param batchSize 批量大小
   * @param concurrency 并发处理数量（由于速率限制，建议使用较低的值）
   * @param resumeFrom 从哪个位置继续索引（用于恢复中断的索引）
   */
  async indexAllCases(
    indices: string[] = ['surgery_records'], 
    batchSize: number = 100,
    concurrency: number = 3, // 降低默认并发数，适应速率限制
    resumeFrom: number = 0
  ): Promise<void> {
    if (this.indexingStatus.isIndexing) {
      throw new Error('Indexing is already in progress');
    }

    // 如果resumeFrom > 0，表示从上次进度继续
    const isResuming = resumeFrom > 0;
    
    if (!isResuming) {
      // 开始新的索引，重置状态
      this.indexingStatus = {
        isIndexing: true,
        totalCases: 0,
        indexedCases: 0,
        failedCases: 0,
        startTime: new Date().toISOString(),
        currentIndex: indices[0]
      };
    } else {
      // 继续索引，更新状态
      this.indexingStatus = {
        ...this.indexingStatus,
        isIndexing: true,
        startTime: new Date().toISOString(),
        currentIndex: indices[0]
      };
    }
    
    this.saveIndexingStatus();

    try {
      for (const indexName of indices) {
        this.indexingStatus.currentIndex = indexName;
        this.saveIndexingStatus();

        log.info(`Starting to index cases from ${indexName}...`);
        
        // 获取索引中的总文档数
        const countResponse = await this.elasticsearch.getCaseClient().count({
          index: indexName
        });
        
        const totalDocs = countResponse.count;
        
        // 如果是继续索引，使用之前的总数，否则设置新的总数
        if (!isResuming) {
          this.indexingStatus.totalCases = totalDocs;
          this.saveIndexingStatus();
        }
        
        log.info(`Found ${totalDocs} cases in ${indexName}`);
        
        if (isResuming) {
          log.info(`Resuming from position ${resumeFrom}/${totalDocs}`);
        }

        // 分批处理文档
        let from = isResuming ? resumeFrom : 0;
        let batchNumber = Math.floor(from / batchSize) + 1;
        
        while (from < totalDocs) {
          const searchResponse = await this.elasticsearch.getCaseClient().search({
            index: indexName,
            body: {
              query: { match_all: {} },
              from,
              size: batchSize
            }
          });

          const hits = searchResponse.hits.hits;
          if (hits.length === 0) break;

          log.info(`Processing batch ${batchNumber} (${from + 1} to ${from + hits.length})...`);

          // 使用串行处理，因为速率限制器已经控制了频率
          // 降低并发数量以避免触发速率限制
          const effectiveConcurrency = Math.min(concurrency, 3); // 最大并发3个
          const batchPromises: Promise<void>[] = [];
          let processedInBatch = 0;
          
          for (let i = 0; i < hits.length; i++) {
            const hit = hits[i];
            const promise = this.processCaseEmbedding(hit, indexName, i + 1, hits.length)
              .then(() => {
                processedInBatch++;
                // 报告批次内进度
                if (processedInBatch % 10 === 0) {
                  const totalProcessed = from + processedInBatch;
                  this.reportProgress(totalProcessed, totalDocs);
                }
              });
            
            batchPromises.push(promise);

            // 控制并发数量，使用更保守的设置
            if (batchPromises.length >= effectiveConcurrency) {
              await Promise.all(batchPromises);
              batchPromises.length = 0;
              
              // 在批次之间添加小延迟，避免突发请求
              if (effectiveConcurrency > 1) {
                await new Promise(resolve => setTimeout(resolve, 100));
              }
            }
          }

          // 处理剩余的promises
          if (batchPromises.length > 0) {
            await Promise.all(batchPromises);
          }

          from += hits.length;
          batchNumber++;
          
          // 报告批次完成进度
          this.reportProgress(from, totalDocs);
        }

        log.info(`Completed indexing ${indexName}`);
      }

      // 确保最终保存
      this.saveCache();
      
      // 清理定时器
      this.cleanupCacheSaveTimeout();
      
      this.indexingStatus = {
        ...this.indexingStatus,
        isIndexing: false,
        endTime: new Date().toISOString()
      };
      this.saveIndexingStatus();

      log.info(`Indexing completed. Total: ${this.indexingStatus.indexedCases} cases indexed, ${this.indexingStatus.failedCases} failed`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      
      log.error('Indexing failed:', { 
        message: errorMessage,
        stack: errorStack 
      });
      
      // 清理定时器
      this.cleanupCacheSaveTimeout();
      
      this.indexingStatus = {
        ...this.indexingStatus,
        isIndexing: false,
        endTime: new Date().toISOString(),
        lastError: errorMessage
      };
      this.saveIndexingStatus();
      
      // 重新抛出错误，确保调用者能捕获到
      throw new Error(`Case indexing failed: ${errorMessage}`);
    }
  }

  /**
   * 获取索引状态
   */
  getIndexingStatus(): IndexingStatus {
    return { ...this.indexingStatus };
  }

  /**
   * 停止索引过程
   */
  stopIndexing(): void {
    if (this.indexingStatus.isIndexing) {
      this.indexingStatus.isIndexing = false;
      this.saveIndexingStatus();
      
      // 清理定时器
      this.cleanupCacheSaveTimeout();
      
      log.info('Indexing stopped by user request');
    }
  }

  /**
   * 重置索引状态
   */
  resetIndexingStatus(): void {
    this.indexingStatus = {
      isIndexing: false,
      totalCases: 0,
      indexedCases: 0,
      failedCases: 0
    };
    this.saveIndexingStatus();
    log.info('Indexing status reset');
  }

  /**
   * 语义搜索病例
   * @param query 搜索查询
   * @param topK 返回结果数量
   * @param filters 过滤条件
   */
  async search(
    query: string, 
    topK: number = 10,
    filters?: {
      index?: string;
      surgeryType?: string;
      dataSource?: string;
      minScore?: number;
    }
  ): Promise<Array<{
    caseId: string;
    index: string;
    score: number;
    text: string;
    metadata: any;
    highlight?: string;
  }>> {
    if (this.index.length === 0) {
      throw new Error('No cases indexed yet. Please run indexing first.');
    }

    // 生成查询的嵌入向量
    const queryEmbedding = await getEmbedding(query);
    
    // 计算相似度
    let results = this.index.map(entry => {
      const score = this.cosineSimilarity(queryEmbedding, entry.embedding);
      return {
        caseId: entry.caseId,
        index: entry.index,
        score,
        text: entry.text,
        metadata: entry.metadata
      };
    });

    // 应用过滤器
    if (filters) {
      results = results.filter(result => {
        if (filters.index && result.index !== filters.index) return false;
        if (filters.surgeryType && result.metadata.surgeryType !== filters.surgeryType) return false;
        if (filters.dataSource && result.metadata.dataSource !== filters.dataSource) return false;
        if (filters.minScore && result.score < filters.minScore) return false;
        return true;
      });
    }

    // 排序并返回topK结果
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(result => ({
        ...result,
        highlight: this.extractHighlight(result.text, query)
      }));
  }

  /**
   * 混合搜索：结合语义搜索和关键词搜索
   */
  async hybridSearch(
    query: string,
    topK: number = 10,
    options?: {
      semanticWeight?: number;
      keywordWeight?: number;
      filters?: any;
    }
  ): Promise<any> {
    const semanticWeight = options?.semanticWeight ?? 0.7;
    const keywordWeight = options?.keywordWeight ?? 0.3;
    const filters = options?.filters;

    // 并行执行语义搜索和关键词搜索
    const [semanticResults, keywordResults] = await Promise.all([
      this.search(query, topK * 2, filters),
      this.keywordSearch(query, topK * 2, filters)
    ]);

    // 合并结果
    const resultMap = new Map<string, any>();
    
    // 添加语义搜索结果
    semanticResults.forEach(result => {
      resultMap.set(`${result.index}_${result.caseId}`, {
        ...result,
        semanticScore: result.score,
        keywordScore: 0,
        combinedScore: result.score * semanticWeight
      });
    });

    // 添加关键词搜索结果并更新分数
    keywordResults.forEach((result: any) => {
      const key = `${result.index}_${result.caseId}`;
      if (resultMap.has(key)) {
        const existing = resultMap.get(key)!;
        existing.keywordScore = result.score;
        existing.combinedScore = existing.semanticScore * semanticWeight + result.score * keywordWeight;
      } else {
        resultMap.set(key, {
          ...result,
          semanticScore: 0,
          keywordScore: result.score,
          combinedScore: result.score * keywordWeight
        });
      }
    });

    // 按综合分数排序
    return Array.from(resultMap.values())
      .sort((a, b) => b.combinedScore - a.combinedScore)
      .slice(0, topK);
  }

  /**
   * 关键词搜索（使用Elasticsearch）
   */
  async keywordSearch(
    query: string,
    size: number = 10,
    filters?: any
  ): Promise<any> {
    try {
      const response = await this.elasticsearch.queryInCaseElasticsearch({
        surgical_record: query,
        query_mode: 'match'
      }, size);

      return response.hits.map((hit: any) => ({
        caseId: hit._id,
        index: hit._index,
        score: hit._score,
        text: this.caseToText(hit._source),
        metadata: this.extractMetadata(hit._source)
      }));
    } catch (error) {
      console.error('Keyword search failed:', error);
      return [];
    }
  }

  /**
   * 获取病例详情
   */
  async getCaseDetails(caseId: string, index: string = 'surgery_records'): Promise<any> {
    try {
      const response = await this.elasticsearch.getCaseClient().get({
        index,
        id: caseId
      });
      return response._source;
    } catch (error) {
      console.error(`Failed to get case details for ${caseId}:`, error);
      throw error;
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalCases: number;
    indexedCases: number;
    indices: string[];
    lastUpdated?: string;
  } {
    const indices = [...new Set(this.index.map(e => e.index))];
    const lastUpdated = this.index.length > 0 
      ? new Date(Math.max(...this.index.map(e => new Date(e.updatedAt).getTime()))).toISOString()
      : undefined;

    return {
      totalCases: this.index.length,
      indexedCases: this.index.length,
      indices,
      lastUpdated
    };
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.index = [];
    if (fs.existsSync(CASE_CACHE_FILE)) {
      fs.unlinkSync(CASE_CACHE_FILE);
    }
    log.info('Case embeddings cache cleared');
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private extractHighlight(text: string, query: string): string {
    // 简单的关键词高亮提取
    const queryWords = query.toLowerCase().split(/\s+/);
    const lines = text.split('\n');
    
    for (const line of lines) {
      const lowerLine = line.toLowerCase();
      for (const word of queryWords) {
        if (word.length > 2 && lowerLine.includes(word)) {
          return line.substring(0, 200) + '...';
        }
      }
    }
    
    return text.substring(0, 150) + '...';
  }
}

export const caseRAGSystem = new CaseRAGSystem();