import { Client as Client9 } from '@elastic/elasticsearch8';
import { Client as Client8 } from '@elastic/elasticsearch8';

import dotenv from 'dotenv';
import { log } from './logger';
import adapter from './db';

dotenv.config();

export type ElasticsearchIndexConfig = {
  indexName: string;
  mapping: Record<string, any>;
  settings?: Record<string, any>;
};

export type ElasticsearchDocument = {
  _id?: string;
  _index: string;
  _source: Record<string, any>;
};

export class ElasticsearchAdapter {
  private client: any;
  private caseClient: any;
  private readonly defaultIndexPrefix: string;

  constructor() {
    const node = process.env.ELASTICSEARCH_NODE || 'http://localhost:9200';
    const caseNode = process.env.ELASTICSEARCH_CASE_NODE || 'http://localhost:9200';
    const username = process.env.ELASTICSEARCH_USERNAME;
    const password = process.env.ELASTICSEARCH_PASSWORD;
    
    const auth = username && password ? { username, password } : undefined;
    
    // 如果主节点是 ES9，使用 v9 客户端；如果 case 节点为 v8/7，使用别名安装的 v8 客户端
    this.client = new Client9({
      node,
      auth,
      tls: process.env.ELASTICSEARCH_TLS === 'true' ? { rejectUnauthorized: false } : undefined,
    });

    this.caseClient = new Client8({
      node: caseNode,
      auth,
      tls: process.env.ELASTICSEARCH_TLS === 'true' ? { rejectUnauthorized: false } : undefined
    });

    this.defaultIndexPrefix = process.env.ELASTICSEARCH_INDEX_PREFIX || 'medical_';
  }

  /**
   * 检查Elasticsearch连接
   */
  async ping(): Promise<boolean> {
    try {
      await this.client.ping();
      log.info('Elasticsearch connection successful');
      return true;
    } catch (error) {
      console.error('Elasticsearch connection failed:', error);
      try {
        await this.caseClient.ping();
        log.info('Elasticsearch case connection successful');
        return true;
      } catch (caseError) {
        console.error('Elasticsearch case connection failed:', caseError);
        return false;
      }
    }
  }

  /**
   * 获取集群信息
   */
  async getClusterInfo(): Promise<any> {
    try {
      const info = await this.client.info();
      return info;
    } catch (error) {
      console.error('Failed to get cluster info:', error);
      throw error;
    }
  }

  /**
   * 创建索引
   */
  async createIndex(config: ElasticsearchIndexConfig): Promise<boolean> {
    try {
      const { indexName, mapping, settings } = config;
      
      const exists = await this.client.indices.exists({ index: indexName });
      if (exists) {
        log.info(`Index ${indexName} already exists`);
        return true;
      }

      const createParams: any = {
        index: indexName,
        body: {
          mappings: mapping,
        }
      };

      if (settings) {
        createParams.body.settings = settings;
      }

      await this.client.indices.create(createParams);
      log.info(`Index ${indexName} created successfully`);
      return true;
    } catch (error) {
      console.error(`Failed to create index ${config.indexName}:`, error);
      throw error;
    }
  }

  /**
   * 索引文档
   */
  async indexDocument(indexName: string, document: Record<string, any>, id?: string): Promise<any> {
    try {
      const params: any = {
        index: indexName,
        body: document,
      };

      if (id) {
        params.id = id;
      }

      const response = await this.client.index(params);
      return response;
    } catch (error) {
      console.error(`Failed to index document in ${indexName}:`, error);
      throw error;
    }
  }

  /**
   * 批量索引文档
   */
  async bulkIndexDocuments(indexName: string, documents: Array<{ id?: string; document: Record<string, any> }>): Promise<any> {
    try {
      const body = documents.flatMap(doc => [
        { index: { _index: indexName, _id: doc.id } },
        doc.document
      ]);

      const response = await this.client.bulk({ refresh: true, body });
      
      if (response.errors) {
        const erroredDocuments: any[] = [];
        response.items.forEach((action: any, i: number) => {
          const operation = Object.keys(action)[0];
          if (action[operation].error) {
            erroredDocuments.push({
              status: action[operation].status,
              error: action[operation].error,
              document: documents[i]
            });
          }
        });
        console.error('Bulk indexing errors:', erroredDocuments);
      }

      return response;
    } catch (error) {
      console.error(`Failed to bulk index documents in ${indexName}:`, error);
      throw error;
    }
  }

  /**
   * 搜索文档
   */
  async search(indexName: string, query: any, size: number = 10): Promise<any> {
    try {
      const response = await this.client.search({
        index: indexName,
        ...query, // 将查询参数展开到顶层
        size
      });

      return {
        hits: response.hits.hits.map((hit: any) => ({
          _id: hit._id,
          _score: hit._score,
          ...hit._source
        })),
        total: response.hits.total
      };
    } catch (error) {
      console.error(`Failed to search in ${indexName}:`, error);
      throw error;
    }
  }

  async queryInCaseElasticsearch(params: {
    surgical_record?: string;
    surgery_type?: string;
    surgery_name?: string;
    surgeon?: string;
    anesthesiologist?: string;
    anesthesia_method?: string;
    patient_id?: string;
    visit_id?: string;
    data_source?: string;
    blood_transfusion?: string;
    heparin_dosage?: string;
    contrast_dosage?: string;
    main_path?: string;
    query_mode?: string;
  }, size: number = 10): Promise<any> {
    try {
      // 构建查询条件
      const mustClauses: any[] = [];
      
      // 添加各个字段的查询条件
      if (params.surgical_record) {
        mustClauses.push({
          [params.query_mode === 'match_phrase' ? 'match_phrase' : 'match']: {
            '手术记录': params.surgical_record
          }
        });
      }
      
      if (params.surgery_type) {
        mustClauses.push({
          [params.query_mode === 'match_phrase' ? 'match_phrase' : 'match']: {
            '手术类型': params.surgery_type
          }
        });
      }
      
      if (params.surgery_name) {
        mustClauses.push({
          [params.query_mode === 'match_phrase' ? 'match_phrase' : 'match']: {
            '手术名称': params.surgery_name
          }
        });
      }
      
      if (params.surgeon) {
        mustClauses.push({
          [params.query_mode === 'match_phrase' ? 'match_phrase' : 'match']: {
            '手术医师': params.surgeon
          }
        });
      }
      
      if (params.anesthesiologist) {
        mustClauses.push({
          [params.query_mode === 'match_phrase' ? 'match_phrase' : 'match']: {
            '麻醉医师': params.anesthesiologist
          }
        });
      }
      
      if (params.anesthesia_method) {
        mustClauses.push({
          [params.query_mode === 'match_phrase' ? 'match_phrase' : 'match']: {
            '麻醉方式': params.anesthesia_method
          }
        });
      }
      
      if (params.patient_id) {
        mustClauses.push({
          [params.query_mode === 'match_phrase' ? 'match_phrase' : 'match']: {
            '唯一ID号': params.patient_id
          }
        });
      }
      
      if (params.visit_id) {
        mustClauses.push({
          [params.query_mode === 'match_phrase' ? 'match_phrase' : 'match']: {
            '就诊流水号': params.visit_id
          }
        });
      }
      
      if (params.data_source) {
        mustClauses.push({
          [params.query_mode === 'match_phrase' ? 'match_phrase' : 'match']: {
            '数据来源': params.data_source
          }
        });
      }
      
      if (params.blood_transfusion) {
        mustClauses.push({
          [params.query_mode === 'match_phrase' ? 'match_phrase' : 'match']: {
            '有无输血': params.blood_transfusion
          }
        });
      }
      
      if (params.heparin_dosage) {
        mustClauses.push({
          [params.query_mode === 'match_phrase' ? 'match_phrase' : 'match']: {
            '肝素用量': params.heparin_dosage
          }
        });
      }
      
      if (params.contrast_dosage) {
        mustClauses.push({
          [params.query_mode === 'match_phrase' ? 'match_phrase' : 'match']: {
            '造影剂用量': params.contrast_dosage
          }
        });
      }
      
      if (params.main_path) {
        mustClauses.push({
          [params.query_mode === 'match_phrase' ? 'match_phrase' : 'match']: {
            '主要路径': params.main_path
          }
        });
      }
      
      // 构建最终查询
      const query = mustClauses.length > 0 ? { bool: { must: mustClauses } } : { match_all: {} };
      
      const response = await this.caseClient.search({
        index: 'surgery_records',
        query,
        size
      });
      
      return {
        hits: response.hits.hits.map((hit: any) => ({
          _id: hit._id,
          _score: hit._score,
          ...hit._source
        })),
        total: response.hits.total,
        query_used: query
      };
    }
    catch (error) {
      console.error(`Failed to search in case Elasticsearch:`, error);
      throw error;
    }
  }


  /**
   * 跨所有索引搜索（全库搜索）
   */
  async searchAllIndices(searchText: string, size: number = 10): Promise<any> {
    try {
      const query = {
        query: {
          multi_match: {
            query: searchText,
            fields: ['*'],
            type: 'best_fields' as const,
            fuzziness: 'AUTO'
          }
        }
      };

      const response = await this.client.search({
        index: `*`, // 搜索所有索引
        ...query, // 将查询参数展开到顶层
        size
      });

      // 按索引分组结果
      const hitsByIndex: Record<string, any[]> = {};
      response.hits.hits.forEach((hit: any) => {
        const index = hit._index;
        if (!hitsByIndex[index]) {
          hitsByIndex[index] = [];
        }
        hitsByIndex[index].push({
          _id: hit._id,
          _score: hit._score,
          ...hit._source
        });
      });

      return {
        hits: response.hits.hits.map((hit: any) => ({
          _id: hit._id,
          _score: hit._score,
          _index: hit._index,
          ...hit._source
        })),
        hitsByIndex,
        total: response.hits.total,
        indices: Object.keys(hitsByIndex)
      };
    } catch (error) {
      console.error('Failed to search across all indices:', error);
      throw error;
    }
  }

  /**
   * 在指定索引中搜索
   */
  async searchInIndex(indexName: string, searchText: string, fields: string[] = ['*'], size: number = 10): Promise<any> {
    try {
      const query = {
        query: {
          multi_match: {
            query: searchText,
            fields: fields,
            type: 'best_fields' as const,
            fuzziness: 'AUTO'
          }
        }
      };

      const response = await this.client.search({
        index: indexName,
        ...query, // 将查询参数展开到顶层
        size
      });

      return {
        hits: response.hits.hits.map((hit: any) => ({
          _id: hit._id,
          _score: hit._score,
          ...hit._source
        })),
        total: response.hits.total,
        index: indexName
      };
    } catch (error) {
      console.error(`Failed to search in index ${indexName}:`, error);
      throw error;
    }
  }

  /**
   * 获取所有索引列表
   */
  async getAllIndices(): Promise<string[]> {
    try {
      const response = await this.client.cat.indices({ format: 'json' });
      return response.map((index: any) => index.index).filter((index: string) => 
        index.startsWith(this.defaultIndexPrefix)
      );
    } catch (error) {
      console.error('Failed to get all indices:', error);
      throw error;
    }
  }

  /**
   * 全文搜索
   */
  async fullTextSearch(indexName: string, searchText: string, fields: string[] = ['*'], size: number = 10): Promise<any> {
    const query = {
      query: {
        multi_match: {
          query: searchText,
          fields: fields,
          type: 'best_fields' as const,
          fuzziness: 'AUTO'
        }
      }
    };

    return this.search(indexName, query, size);
  }

  /**
   * 获取文档
   */
  async getDocument(indexName: string, id: string): Promise<any> {
    try {
      const response = await this.client.get({
        index: indexName,
        id
      });

      const result: any = {
        _id: response._id
      };
      
      if (response._source) {
        Object.assign(result, response._source);
      }

      return result;
    } catch (error: any) {
      if (error.meta?.statusCode === 404) {
        return null;
      }
      console.error(`Failed to get document ${id} from ${indexName}:`, error);
      throw error;
    }
  }

  /**
   * 更新文档
   */
  async updateDocument(indexName: string, id: string, document: Record<string, any>): Promise<any> {
    try {
      const response = await this.client.update({
        index: indexName,
        id,
        doc: document
      });

      return response;
    } catch (error) {
      console.error(`Failed to update document ${id} in ${indexName}:`, error);
      throw error;
    }
  }

  /**
   * 删除文档
   */
  async deleteDocument(indexName: string, id: string): Promise<any> {
    try {
      const response = await this.client.delete({
        index: indexName,
        id
      });

      return response;
    } catch (error) {
      console.error(`Failed to delete document ${id} from ${indexName}:`, error);
      throw error;
    }
  }

  /**
   * 删除索引
   */
  async deleteIndex(indexName: string): Promise<boolean> {
    try {
      const exists = await this.client.indices.exists({ index: indexName });
      if (!exists) {
        log.info(`Index ${indexName} does not exist`);
        return false;
      }

      await this.client.indices.delete({ index: indexName });
      log.info(`Index ${indexName} deleted successfully`);
      return true;
    } catch (error) {
      console.error(`Failed to delete index ${indexName}:`, error);
      throw error;
    }
  }

  /**
   * 获取索引统计信息
   */
  async getIndexStats(indexName: string): Promise<any> {
    try {
      const response = await this.client.indices.stats({ index: indexName });
      return response;
    } catch (error) {
      console.error(`Failed to get stats for index ${indexName}:`, error);
      throw error;
    }
  }

  /**
   * 获取索引映射
   */
  async getIndexMapping(indexName: string): Promise<any> {
    try {
      const response = await this.client.indices.getMapping({ index: indexName });
      return response;
    } catch (error) {
      console.error(`Failed to get mapping for index ${indexName}:`, error);
      throw error;
    }
  }

  /**
   * 同步数据库表到Elasticsearch
   */
  async syncTableToElasticsearch(
    tableName: string, 
    data: any[], 
    idField: string = 'id',
    indexName?: string
  ): Promise<any> {
    const targetIndex = indexName || tableName.toLowerCase();
    
    try {
      // 检查索引是否已存在
      const indexExists = await this.indexExists(targetIndex);
      
      // 创建索引（如果不存在）
      // 优先使用PostgreSQL schema生成映射，如果失败则回退到基于数据的映射
      let mapping: Record<string, any>;
      try {
        mapping = await this.generateMappingFromPostgresSchema(tableName);
        log.info(`Generated mapping from PostgreSQL schema for table ${tableName}`);
      } catch (error) {
        log.warn(`Failed to generate mapping from PostgreSQL schema for table ${tableName}, using data-based mapping`);
        mapping = this.generateMappingFromData(data);
      }
      
      await this.createIndex({
        indexName: targetIndex,
        mapping
      });

      // 批量索引数据
      const documents = data.map(row => ({
        id: row[idField]?.toString(),
        document: row
      }));

      const result = await this.bulkIndexDocuments(targetIndex, documents);
      
      log.info(`Synced ${data.length} documents from table ${tableName} to index ${targetIndex}`);
      return result;
    } catch (error) {
      console.error(`Failed to sync table ${tableName} to Elasticsearch:`, error);
      throw error;
    }
  }

  /**
   * 从PostgreSQL schema生成映射
   */
  private async generateMappingFromPostgresSchema(tableName: string): Promise<Record<string, any>> {
    try {
      // 获取表的列信息
      const schema = process.env.DB_SCHEMA || 'public';
      const sql = `
        SELECT 
          column_name as "COLUMN_NAME",
          data_type as "DATA_TYPE",
          udt_name as "UDT_NAME",
          is_nullable as "IS_NULLABLE",
          column_default as "COLUMN_DEFAULT"
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position
      `;
      
      const columns = await adapter.query(sql, [schema, tableName]);
      
      if (columns.length === 0) {
        log.warn(`No columns found for table ${tableName}, using data-based mapping`);
        return { properties: {} };
      }

      const properties: Record<string, any> = {};

      for (const column of columns) {
        const columnName = column.COLUMN_NAME;
        const dataType = column.DATA_TYPE;
        const udtName = column.UDT_NAME;
        
        // 将PostgreSQL类型映射到Elasticsearch类型
        let esType = this.mapPostgresTypeToElasticsearch(dataType, udtName);
        
        properties[columnName] = { type: esType };
        
        // 如果是日期类型，设置格式
        if (esType === 'date') {
          properties[columnName].format = 'strict_date_optional_time||epoch_millis';
        }
      }

      return {
        properties,
        dynamic_templates: [
          {
            strings_as_keywords: {
              match_mapping_type: "string",
              mapping: {
                type: "keyword",
                fields: {
                  text: { type: "text" }
                }
              }
            }
          }
        ]
      };
    } catch (error) {
      console.error(`Failed to generate mapping from PostgreSQL schema for table ${tableName}:`, error);
      // 如果失败，回退到基于数据的映射
      return { properties: {} };
    }
  }

  /**
   * 将PostgreSQL类型映射到Elasticsearch类型
   */
  private mapPostgresTypeToElasticsearch(pgType: string, udtName?: string): string {
    // 处理UDT类型（如timestamp, timestamptz等）
    if (udtName) {
      switch (udtName.toLowerCase()) {
        case 'timestamp':
        case 'timestamptz':
        case 'date':
        case 'time':
        case 'timetz':
          return 'date';
        case 'int2':
        case 'int4':
          return 'integer';
        case 'int8':
          return 'long';
        case 'float4':
          return 'float';
        case 'float8':
          return 'double';
        case 'numeric':
        case 'decimal':
          return 'scaled_float';
        case 'bool':
          return 'boolean';
        case 'json':
        case 'jsonb':
          return 'object';
        case 'uuid':
          return 'keyword';
      }
    }

    // 处理标准数据类型
    switch (pgType.toLowerCase()) {
      case 'integer':
      case 'smallint':
      case 'int':
        return 'integer';
      case 'bigint':
        return 'long';
      case 'real':
      case 'float':
        return 'float';
      case 'double precision':
        return 'double';
      case 'numeric':
      case 'decimal':
        return 'scaled_float';
      case 'boolean':
        return 'boolean';
      case 'character':
      case 'character varying':
      case 'text':
      case 'varchar':
        return 'text';
      case 'timestamp':
      case 'timestamp without time zone':
      case 'timestamp with time zone':
      case 'date':
      case 'time':
      case 'time without time zone':
      case 'time with time zone':
        return 'date';
      case 'json':
      case 'jsonb':
        return 'object';
      case 'uuid':
        return 'keyword';
      case 'bytea':
        return 'binary';
      case 'array':
        return 'nested';
      default:
        // 对于未知类型，默认使用text
        return 'text';
    }
  }

  /**
   * 从数据生成映射（备用方法）
   */
  private generateMappingFromData(data: any[]): Record<string, any> {
    if (data.length === 0) {
      return {
        properties: {}
      };
    }

    const sample = data[0];
    const properties: Record<string, any> = {};

    for (const [key, value] of Object.entries(sample)) {
      const type = this.inferElasticsearchType(value);
      properties[key] = { type };
    }

    return {
      properties,
      dynamic_templates: [
        {
          strings_as_keywords: {
            match_mapping_type: "string",
            mapping: {
              type: "keyword",
              fields: {
                text: { type: "text" }
              }
            }
          }
        }
      ]
    };
  }

  /**
   * 推断Elasticsearch类型
   */
  private inferElasticsearchType(value: any): string {
    if (value === null || value === undefined) {
      return 'text';
    }

    const type = typeof value;

    switch (type) {
      case 'number':
        return Number.isInteger(value) ? 'integer' : 'float';
      case 'boolean':
        return 'boolean';
      case 'string':
        // 检查是否是日期字符串
        if (this.isDateString(value)) {
          return 'date';
        }
        return 'text';
      case 'object':
        if (Array.isArray(value)) {
          return 'nested';
        }
        if (value instanceof Date) {
          return 'date';
        }
        return 'object';
      default:
        return 'text';
    }
  }

  /**
   * 检查是否是日期字符串
   */
  private isDateString(str: string): boolean {
    // 扩展的日期格式检查
    const datePatterns = [
      /^\d{4}-\d{2}-\d{2}$/, // YYYY-MM-DD
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, // ISO格式
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/, // ISO格式带毫秒
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, // YYYY-MM-DD HH:MM:SS
      /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/, // YYYY/MM/DD HH:MM:SS
      /^\d{2}\/\d{2}\/\d{4}$/, // MM/DD/YYYY
      /^\d{4}\/\d{2}\/\d{2}$/, // YYYY/MM/DD
      /^\d{2}-\d{2}-\d{4}$/, // DD-MM-YYYY
      /^\d{8}$/, // YYYYMMDD
      /^\d{14}$/, // YYYYMMDDHHMMSS
    ];

    // 尝试解析日期
    if (datePatterns.some(pattern => pattern.test(str))) {
      return true;
    }

    // 尝试使用Date对象解析
    const date = new Date(str);
    return !isNaN(date.getTime());
  }



  /**
   * 检查索引是否存在
   */
  async indexExists(indexName: string): Promise<boolean> {
    try {
      const exists = await this.client.indices.exists({ index: indexName });
      return exists;
    } catch (error) {
      console.error(`Failed to check if index ${indexName} exists:`, error);
      throw error;
    }
  }







  /**
   * 统计文档数量
   */
  async countDocuments(indexName: string): Promise<number> {
    try {
      const response = await this.client.count({
        index: indexName
      });
      return response.count;
    } catch (error: any) {
      if (error.meta?.statusCode === 404) {
        return 0;
      }
      console.error(`Failed to count documents in ${indexName}:`, error);
      throw error;
    }
  }

  /**
   * 通配符匹配函数
   */
  private matchWildcard(pattern: string, text: string): boolean {
    // 将通配符模式转换为正则表达式
    const regexPattern = pattern
      .replace(/\*/g, '.*')  // * 匹配任意字符
      .replace(/\?/g, '.')   // ? 匹配单个字符
      .replace(/\[!/g, '[^') // [! 转换为 [^
      .replace(/\[/g, '[')   // 保持其他字符
      .replace(/\]/g, ']');  // 保持其他字符
    
    const regex = new RegExp(`^${regexPattern}$`, 'i');
    return regex.test(text);
  }

  /**
   * 自动同步数据库中的所有数据表到Elasticsearch
   * @param tablePattern 表名通配符模式，例如：'patient*', '*_log', 'user?'
   * @param excludePattern 排除表名通配符模式
   * @param batchSize 批量处理大小
   * @param idField 主键字段名，默认为'id'
   * @param indexPrefix 索引前缀，如果为空则使用默认前缀
   * @returns 同步结果统计
   */
  async syncAllTablesToElasticsearch(
    tablePattern: string = '*',
    excludePattern?: string,
    batchSize: number = 1000,
    idField: string = 'id',
    indexPrefix?: string
  ): Promise<{
    totalTables: number;
    syncedTables: number;
    failedTables: number;
    totalDocuments: number;
    details: Array<{
      tableName: string;
      indexName: string;
      documentCount: number;
      success: boolean;
      error?: string;
    }>;
  }> {
    try {
      log.info(`Starting sync all tables with pattern: ${tablePattern}`);
      
      // 获取数据库元数据
      const { tables } = await adapter.introspect();
      
      // 过滤表名
      const filteredTables = tables.filter(table => {
        const tableName = table.TABLE_NAME || table.table_name;
        
        // 检查是否匹配包含模式
        const matchesInclude = this.matchWildcard(tablePattern, tableName);
        if (!matchesInclude) return false;
        
        // 检查是否匹配排除模式
        if (excludePattern) {
          const matchesExclude = this.matchWildcard(excludePattern, tableName);
          if (matchesExclude) return false;
        }
        
        return true;
      });
      
      log.info(`Found ${filteredTables.length} tables matching pattern`);
      
      const results = {
        totalTables: filteredTables.length,
        syncedTables: 0,
        failedTables: 0,
        totalDocuments: 0,
        details: [] as Array<{
          tableName: string;
          indexName: string;
          documentCount: number;
          success: boolean;
          error?: string;
        }>
      };
      
      // 逐个同步表
      for (const table of filteredTables) {
        const tableName = table.TABLE_NAME || table.table_name;
        const indexName = indexPrefix 
          ? `${indexPrefix}${tableName.toLowerCase()}`
          : tableName.toLowerCase();
        
        try {
          log.info(`Syncing table: ${tableName} to index: ${indexName}`);
          
          // 获取表数据（分页处理）
          let offset = 0;
          let totalRows: any[] = [];
          let hasMoreData = true;
          
          while (hasMoreData) {
            const sql = `SELECT * FROM ${tableName} LIMIT ${batchSize} OFFSET ${offset}`;
            const rows = await adapter.query(sql);
            
            if (rows.length === 0) {
              hasMoreData = false;
            } else {
              totalRows = totalRows.concat(rows);
              offset += batchSize;
              
              // 如果获取的行数小于batchSize，说明没有更多数据了
              if (rows.length < batchSize) {
                hasMoreData = false;
              }
            }
          }
          
          if (totalRows.length === 0) {
            log.info(`Table ${tableName} is empty, skipping`);
            results.details.push({
              tableName,
              indexName,
              documentCount: 0,
              success: true
            });
            results.syncedTables++;
            continue;
          }
          
          // 同步数据到Elasticsearch
          await this.syncTableToElasticsearch(tableName, totalRows, idField, indexName);
          
          // 记录成功
          results.details.push({
            tableName,
            indexName,
            documentCount: totalRows.length,
            success: true
          });
          
          results.syncedTables++;
          results.totalDocuments += totalRows.length;
          
          log.info(`Successfully synced ${totalRows.length} documents from ${tableName}`);
          
        } catch (error: any) {
          const errorMessage = error.message || 'Unknown error';
          console.error(`Failed to sync table ${tableName}:`, error);
          
          results.details.push({
            tableName,
            indexName,
            documentCount: 0,
            success: false,
            error: errorMessage
          });
          
          results.failedTables++;
        }
      }
      
      log.info(`Sync completed: ${results.syncedTables} tables synced, ${results.failedTables} failed, ${results.totalDocuments} total documents`);
      return results;
      
    } catch (error) {
      console.error('Failed to sync all tables:', error);
      throw error;
    }
  }

  /**
   * 获取病例Elasticsearch客户端
   */
  getCaseClient(): any {
    return this.caseClient;
  }

  /**
   * 关闭连接
   */
  async close(): Promise<void> {
    await this.client.close();
    await this.caseClient.close();
  }
}

// 创建单例实例
let elasticsearchAdapter: ElasticsearchAdapter | null = null;

export function getElasticsearchAdapter(): ElasticsearchAdapter {
  if (!elasticsearchAdapter) {
    elasticsearchAdapter = new ElasticsearchAdapter();
  }
  return elasticsearchAdapter;
}

export default getElasticsearchAdapter();