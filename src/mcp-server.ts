import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { buildVirtualTree, VirtualTree, organizeTablesIntoPaths } from './mapping';
import { query } from './db';
import { ragSystem } from './rag';
import { caseRAGSystem } from './case-rag';
import { Logger, loggers } from './logger';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { getElasticsearchAdapter } from './elasticsearch';
import { deserialize } from 'v8';
import { property } from 'zod/v4';
import { match } from 'assert';

dotenv.config();

// 创建MCP服务器专用的日志实例
const log = loggers.mcp;

const SCHEMA_CACHE_FILE = path.join(process.cwd(), 'schema-cache.json');

class MedicalMcpServer {
  private server: Server;
  private tree: VirtualTree | null = null;
  private transport: SSEServerTransport | undefined;
  private medicalTermToolHandler: any;

  constructor() {
    log.info('Initializing Medical MCP Server');
    this.server = new Server(
      {
        name: 'medical-sql-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );


    this.setupResourceHandlers();
    this.setupToolHandlers();

    // 自动开始病例索引
    this.startAutoIndexing();

    // Error handling
    this.server.onerror = (error) => log.error('MCP Error', error);
    process.on('SIGINT', async () => {
      log.info('Shutting down MCP Server');
      await this.server.close();
      process.exit(0);
    });
  }

  /**
   * 自动开始病例索引
   */
  private startAutoIndexing() {
    // 异步检查连接并开始索引
    setTimeout(async () => {
      try {
        // 首先检查索引状态
        const indexingStatus = caseRAGSystem.getIndexingStatus();
        log.info('Current indexing status:', indexingStatus);

        // 如果索引正在进行中，检查是否需要恢复
        if (indexingStatus.isIndexing) {
          log.info('Previous indexing was interrupted. Checking if we should resume...');

          // 检查是否有实际进度
          if (indexingStatus.indexedCases > 0 && indexingStatus.totalCases > 0) {
            const progressPercentage = (indexingStatus.indexedCases / indexingStatus.totalCases) * 100;
            log.info(`Previous indexing progress: ${indexingStatus.indexedCases}/${indexingStatus.totalCases} (${progressPercentage.toFixed(1)}%)`);

            // 如果进度小于100%，尝试恢复索引
            if (progressPercentage < 100) {
              log.info('Resuming interrupted indexing...');
              await this.resumeCaseIndexing();
              return;
            }
          }

          // 如果进度是100%或没有有效进度，重置状态
          log.info('Resetting indexing status...');
          caseRAGSystem.resetIndexingStatus();
        }

        // 开始新的索引或继续已完成的索引
        await this.startOrContinueCaseIndexing();

      } catch (error) {
        log.error('Failed to start auto indexing:', error);
      }
    }, 5000); // 延迟5秒开始，确保其他初始化完成
  }

  /**
   * 恢复中断的索引
   */
  private async resumeCaseIndexing(): Promise<void> {
    try {
      const elastic = getElasticsearchAdapter();
      const isConnected = await elastic.ping();

      if (!isConnected) {
        log.warn('Elasticsearch connection failed, cannot resume indexing');
        caseRAGSystem.resetIndexingStatus();
        return;
      }

      // 检查病例索引是否仍然存在
      const indices = ['surgery_records'];
      for (const indexName of indices) {
        try {
          const exists = await elastic.getCaseClient().indices.exists({ index: indexName });
          if (exists) {
            log.info(`Resuming indexing from ${indexName}...`);

            // 计算从哪个位置继续（已经索引的病例数量）
            const indexingStatus = caseRAGSystem.getIndexingStatus();
            const resumeFrom = indexingStatus.indexedCases;

            log.info(`Resuming from position ${resumeFrom}`);

            // 首先重置索引状态，确保可以开始新的索引
            caseRAGSystem.resetIndexingStatus();

            // 从上次进度继续索引（使用默认并发数）
            caseRAGSystem.indexAllCases([indexName], 100, 3, resumeFrom).catch(error => {
              log.error('Failed to resume indexing', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
              });
            });
            return;
          }
        } catch (error) {
          log.warn(`Failed to check index ${indexName}:`, error);
        }
      }

      log.warn('Case index not found, cannot resume indexing');
      caseRAGSystem.resetIndexingStatus();

    } catch (error) {
      log.error('Failed to resume indexing:', error);
      caseRAGSystem.resetIndexingStatus();
    }
  }

  /**
   * 开始新的索引或继续已完成的索引
   */
  private async startOrContinueCaseIndexing(): Promise<void> {
    try {
      const elastic = getElasticsearchAdapter();
      const isConnected = await elastic.ping();

      if (!isConnected) {
        log.warn('Elasticsearch connection failed, skipping case indexing');
        return;
      }

      // 检查病例索引是否存在
      const indices = ['surgery_records'];
      let hasCaseData = false;

      for (const indexName of indices) {
        try {
          const exists = await elastic.getCaseClient().indices.exists({ index: indexName });
          if (exists) {
            hasCaseData = true;
            log.info(`Found case index: ${indexName}`);

            // 检查是否已经有缓存的嵌入
            const stats = caseRAGSystem.getStats();
            if (stats.indexedCases === 0) {
              // 没有缓存的嵌入，开始新的索引
              log.info('Starting new case indexing...');
              // 重置索引状态，确保可以开始新的索引
              caseRAGSystem.resetIndexingStatus();
              caseRAGSystem.indexAllCases([indexName], 100, 3, 0).catch(error => {
                log.error('Case indexing failed', {
                  error: error instanceof Error ? error.message : String(error),
                  stack: error instanceof Error ? error.stack : undefined
                });
              });
            } else {
              // 已经有缓存的嵌入，检查是否需要继续
              log.info(`Case RAG already has ${stats.indexedCases} indexed cases`);

              // 获取索引中的总文档数
              const countResponse = await elastic.getCaseClient().count({
                index: indexName
              });

              const totalDocs = countResponse.count;
              if (stats.indexedCases < totalDocs) {
                log.info(`Continuing indexing: ${stats.indexedCases}/${totalDocs} cases indexed`);
                // 重置索引状态，确保可以继续索引
                caseRAGSystem.resetIndexingStatus();
                // 从已经索引的数量继续
                caseRAGSystem.indexAllCases([indexName], 100, 3, stats.indexedCases).catch(error => {
                  log.error('Failed to continue indexing', {
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined
                  });
                });
              } else {
                log.info('All cases already indexed');
              }
            }
            break;
          }
        } catch (error) {
          log.warn(`Failed to check index ${indexName}:`, error);
        }
      }

      if (!hasCaseData) {
        log.info('No case indices found, skipping case indexing');
      }

    } catch (error) {
      log.error('Failed to start or continue indexing:', error);
    }
  }

  private saveSchemaToCache() {
    if (this.tree) {
      try {
        fs.writeFileSync(SCHEMA_CACHE_FILE, JSON.stringify(this.tree, null, 2));
        log.info(`Schema saved to cache file: ${SCHEMA_CACHE_FILE}`);
      } catch (error) {
        log.error('Failed to save schema to cache', error);
      }
    }
  }

  private async ensureTree() {
    if (!this.tree) {
      // Try loading from cache first
      try {
        if (fs.existsSync(SCHEMA_CACHE_FILE)) {
          log.info(`Loading schema from cache file: ${SCHEMA_CACHE_FILE}`);
          const data = fs.readFileSync(SCHEMA_CACHE_FILE, 'utf-8');
          this.tree = JSON.parse(data);
          log.info(`Schema loaded from cache with ${Object.keys(this.tree?.tables || {}).length} tables`);
          return this.tree!;
        }
      } catch (error) {
        log.error('Failed to load schema from cache, falling back to database', error);
      }

      log.info('Building virtual tree from database...');
      this.tree = await buildVirtualTree();
      log.info(`Virtual tree built with ${Object.keys(this.tree.tables).length} tables`);
      this.saveSchemaToCache();
    }

    // Check if root path structure is missing and we can generate it
    if (this.tree && !this.tree.root && process.env.OPENAI_API_KEY) {
      log.info('Virtual tree is missing path structure. Generating it now...');
      try {
        const tables = Object.values(this.tree.tables);
        this.tree.root = await organizeTablesIntoPaths(tables);
        log.info('Path structure generated successfully.');
        this.saveSchemaToCache();
      } catch (error) {
        log.error('Failed to generate path structure', error);
      }
    }


    if (this.tree && process.env.OPENAI_API_KEY) {
      ragSystem.indexTables(Object.values(this.tree.tables)).catch(err => {
        log.error('Failed to index tables for RAG', err);
      });
    }

    return this.tree!;
  }

  private setupResourceHandlers() {
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      log.info('MCP: Listing resources');
      const response = {
        resources: [
          {
            uri: 'medical://schema',
            name: 'Database Schema Virtual Tree',
            mimeType: 'application/json',
            description: 'The virtual tree structure of the hospital database, categorized by semantics.',
          },
        ],
      };
      log.info('MCP: Resources listed', { count: response.resources.length });
      return response;
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      log.info('MCP: Reading resource', { uri: request.params.uri });
      if (request.params.uri === 'medical://schema') {
        const tree = await this.ensureTree();
        const response = {
          contents: [
            {
              uri: 'medical://schema',
              mimeType: 'application/json',
              text: JSON.stringify(tree, null, 2),
            },
          ],
        };
        log.info('MCP: Schema resource returned', {
          tables: Object.keys(tree.tables).length,
          categories: Object.keys(tree.categories).length
        });
        return response;
      }
      throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${request.params.uri}`);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      log.info('MCP: Listing tools');
      const allowNonSelect = process.env.ALLOW_NON_SELECT_QUERIES === 'true';
      const dbType = process.env.DB_TYPE || 'mysql';
      const response: { tools: any[] } = {
        tools: [
          {
            name: 'query_database',
            description: (allowNonSelect
              ? `Execute a ${dbType} SQL query against the hospital database.`
              : `Execute a read-only ${dbType} SQL query (SELECT only) against the hospital database.`) +
              '',
            inputSchema: {
              type: 'object',
              properties: {
                sql: {
                  type: 'string',
                  description: allowNonSelect
                    ? `The ${dbType} SQL statement to execute`
                    : `The ${dbType} SQL SELECT statement to execute`,
                },
              },
              required: ['sql'],
            },
          },
          // {
          //   name: 'ask_database',
          //   description: 'Ask a natural language question about the hospital data. The system will generate SQL and return results.',
          //   inputSchema: {
          //     type: 'object',
          //     properties: {
          //       question: {
          //         type: 'string',
          //         description: 'The natural language question (e.g., "How many patients with lung cancer?")',
          //       },
          //     },
          //     required: ['question'],
          //   },
          // },
          {
            name: 'schema_ls',
            description: 'List the contents of the virtual file system for the database schema. This is the entry point for database exploration.',
            inputSchema: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'The path to list (e.g., "/" or "/药品管理"). Defaults to root.',
                },
              },
            },
          },
          {
            name: 'get_table_schema',
            description: 'Get the schema (columns and types) of a specific table.',
            inputSchema: {
              type: 'object',
              properties: {
                tableName: {
                  type: 'string',
                  description: 'The name of the table to inspect.',
                },
              },
              required: ['tableName'],
            },
          },
          {
            name: 'get_current_time',
            description: 'Get the current system time. IMPORTANT: Always use this tool first when the user\'s query involves relative time (e.g., "today", "yesterday", "last month") to ensure accurate SQL generation.',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'search_related_tables',
            description: 'Search for tables related to a specific topic or question using RAG (Retrieval-Augmented Generation). Use this when you are not sure which tables contain the information you need.',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'The natural language query or topic to search for (e.g., "patient diagnosis", "surgery costs").',
                },
              },
              required: ['query'],
            },
          },
          {
            name: 'search_all_indices',
            description: 'Search across all Elasticsearch indices (full database search). Use this when you want to find data across all tables without knowing which specific table contains the information.',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'The search query text to find across all indices.',
                },
                size: {
                  type: 'number',
                  description: 'Maximum number of results to return (default: 10).',
                },
              },
              required: ['query'],
            },
          },
          {
            name: 'list_elasticsearch_indices',
            description: 'List all available Elasticsearch indices (tables) that can be searched.',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'search_in_index',
            description: 'Search within a specific Elasticsearch index (table search). Use this when you know which table/index you want to search in.',
            inputSchema: {
              type: 'object',
              properties: {
                indexName: {
                  type: 'string',
                  description: 'The name of the Elasticsearch index to search in (e.g., "medical_patients", "medical_diagnoses").',
                },
                query: {
                  type: 'string',
                  description: 'The search query text.',
                },
                fields: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Specific fields to search in (default: all fields).',
                },
                size: {
                  type: 'number',
                  description: 'Maximum number of results to return (default: 10).',
                },
              },
              required: ['indexName', 'query'],
            },
          },
          //           //PS C:\dev\TimeManager\Medical-SQL-MCP> curl -sS 'http://192.168.3.14:9200/surgery_records/_search' -H 'Content-Type: application/json' -d '{"size":5,"query":{"match":{"手术记录":"脑梗塞"}}}'
          // {"took":294,"timed_out":false,"_shards":{"total":1,"successful":1,"skipped":0,"failed":0},"hits":{"total":{"value":10000,"relation":"gte"},"max_score":6.7877173,"hits":[{"_index":"surgery_records","_id":"a7cd0c0c1b0f937807e8ea581576d5fdd7346bf5","_score":6.7877173,"_ignored":["手术记录.keyword"],"_source":{"数据来源":"TAVR","唯一ID号":"SZPX111000282","就诊流水号":"1677861","手术类型":"神经内科院内会诊记录","手术记录":"会诊类型：普通会诊\n拟请：神经内科李永坤主任医师会诊\n申请日期：2024年12月20日 08时54分\n病情摘要：\n患者陈太斯,男，76岁， 以“反复胸闷、气促1年，加重4天。”为主诉入院。既往“高血压、糖尿病”病史。3月前因“多发性脑梗死（右侧额顶枕颞岛叶 ）”于我院神经内科住院诊治，查颅脑高分辨率MRI：右侧大脑中动脉M1段重度狭窄、闭塞；左侧大脑中动脉M1段相应部分管 腔重度狭窄、近闭塞。特请贵科会诊，协助诊治！\n\n会诊目的：协助诊治\n诊断：1.主动脉瓣重度狭窄 2.慢性心力衰竭  心功能Ⅱ级（NYHA分级）3.高血压病2级（极高危）4.2型糖尿病 5.右侧大脑中动脉M1段闭塞 6.左侧大脑中动M1段重度狭窄 7.主动脉瓣重度狭窄伴关闭不全 8.脑梗死个人史\n会诊申请医师：                               主治以上医师签名： \n会诊意见：\n    病史敬悉。患者3个月前以右侧额顶枕颞岛叶脑梗死收住我科，高分辨磁共振提示右大脑中动脉M1段闭塞 ，左大脑中动脉M1段重度狭窄，脑组织灌注尚可（Tmax＞4s 21.1ml，Tmax＞6s 0ml）。现因主动脉瓣重度狭窄住心内科。入院后复查磁共振，未见新发梗死。 目前mRS评分=2分。\n    拟诊：1.脑梗死恢复期 2.多发脑动脉重度狭窄或闭塞（双侧大脑中动脉） 3.余同贵科。\n    建议：1.患者目前病情较稳定，脑动脉狭窄/闭塞可继续药物治疗；\n          2.必要时 ，进一步行脑动脉造影评估；\n          3.若行全麻手术，建议术中全程血压130mmHg左右，最好不低于110mmHg。\n          4.我科随诊。谢邀！\n\n\n\n\n\n\n会诊医师：         日期：2024-12-20 09:51:29\n","meta":{"source_file":" 患者数据导出20260109_合并(1).xlsx","sheet":"POP_04_手术记录","row_number":12070},"ingested_at":"2026-01-15T12:51:32.786906+00:00"}},{"_index":"surgery_records","_id":"6c2b8858ab0512ffa28191771ab9ef744a0ceade","_score":6.728123,"_ignored":["手术记录.keyword"],"_source":{"数据来源":"TAVI","唯一ID号":"SZPX111000428","就诊流水号":"1332638","手术类型":"神经内科院内会诊记录","手术记录":"\n会诊类型：普通会诊\n拟请：神经内科会诊\n申请日期：2022年07月03日 14时56分\n病情摘要：\n患者严秀美,女，71岁，以“晕厥3次，历3月。”为主诉于入院。入院前5天曾因晕厥倒地后头部血肿外伤。颅脑MRI：1、胼胝体（左侧脑室前方）斑片状异常信号，考虑为脑梗塞可能，建议随诊复查。2、腔隙性脑梗塞，动脉硬化性脑白质变性，脑萎缩。3、所摄入左额部头皮下血肿可能。\n\n\n会诊目的：特请贵科会诊，谢谢！\n诊断：1.主动脉瓣狭窄 2.高血压病3级（极高危） 3.脑梗塞 4.脑萎缩 5.2型糖尿病 6.心律失常 室性早搏（偶发） 房性早搏（偶发） 。\n会诊申请医师：                               主治以上医师签名： （科室盖章）\n会诊意见：病史已复习，病人已查看，患者分别于12天前及10天前有猝倒发作史，自行爬起后觉双上肢麻木、乏力以右手为甚，目前查体右手 远端肌力4级，其余查体未见明显异常，当地头颈部CTA提示脑动脉及颈部动脉粥样硬化未见明显狭窄，磁共振提示胼胝体（ 左侧脑室前方）新发腔隙性脑梗塞病灶，动脉硬化性白质脑病。\n拟诊：1.脑梗死恢复期 2.余同贵科。\n建议：我科建议单联抗血小板聚集，降胆固醇稳定斑块，控制危险因素，康复训练。随诊。\n\n\n\n\n\n\n会诊医师：       詹自雄        日期：2022年07月05日\n","meta":{"source_file":"患者数据导出20260109_合并(1).xlsx","sheet":"POP_04_手术记录","row_number":18242},"ingested_at":"2026-01-15T12:51:35.658787+00:00"}},{"_index":"surgery_records","_id":"e029e3a448deea50ce649d8015b67507e1bbb575","_score":6.671252,"_ignored":["手术记录.keyword"],"_source":{"数据来源":"TAVR","唯一ID号":"SZPX111000306","就诊流水号":"1705996","手术类型":"神经内科院内会诊记录","手术记录":"会诊 类型：普通会诊\n拟请：神经内科刘德山会诊\n申请日期：2025年02月25日 16时46分\n病情摘要：\n再次请神经内科会诊，我科已完善MRI：1、腔隙性脑梗塞，轻度脑萎缩。2、轻度脑动脉硬化。MRA示部分脑动脉走行稍僵直、管壁稍毛糙，部分管 腔粗细稍不均，近端主干稍扩张，末梢分支显示稍少。\n\n\n\n会诊目的：特请贵科会诊，进一步制定治疗方案，谢谢。\n 诊断：1.主动脉瓣重度狭窄2.心脏瓣膜病3.2型糖尿病4.高血压病3级（极高危）5.肺动脉高压6.脑干梗死（左侧脑桥）7.慢 性肾功能不全\n会诊申请医师：                               主治以上医师签名： \n会诊意见：\n病史敬悉，以\"发 现主动脉瓣狭窄1周\"为主诉于2025-02-18 17:03入院。患者1周前于因突发言语含糊，伴呃逆。就诊闽清县医院查：头颅平 扫+颅脑MRA:1、桥脑左侧急性脑梗死。2、桥脑、双侧小脑半球、基底节区、半卵圆区、额顶叶腔隙性脑梗塞。3、脑萎缩、 脑白质变性。4、双侧上颌窦、筛窦炎；左侧中、下鼻甲肥大。5、颅脑MRA示：颅内动脉呈硬化样改变。专科查体：神志清楚，言语清晰，双侧瞳孔等大等圆直径2.0mm，对光灵敏，示齿双侧鼻唇沟对称，伸舌尚居中，四肢肌力、肌张力正常，病理征未引出，脑膜刺激征阴性。头颅MRI、MRA示：1、腔隙性脑梗塞，轻度脑萎缩。2、轻度脑动脉硬化。\n拟诊：脑干梗死（左 侧脑桥）；余同贵科；\n处理：目前暂无绝对手术禁忌，必要时完善SWI检查，随诊，谢邀。\n会诊医师：         日期：2025-02-25 17:04:32\n","meta":{"source_file":"患者数据导出20260109_合并(1).xlsx","sheet":"POP_04_手术记录","row_number":13133},"ingested_at":"2026-01-15T12:51:33.429399+00:00"}},{"_index":"surgery_records","_id":"fdf9aa22bdd66f3e281f8c8c63796717b6cef93c","_score":6.620194,"_ignored":["手术记录.keyword"],"_source":{"数据来源":"TAVR","唯一ID号":"SZPX111000282","就诊流水号":"1677861","手术类型":"神经内科院内会诊记录","手术记录":"会诊类 型：普通会诊\n拟请：神经内科李永坤主任医师会诊\n申请日期：2024年12月13日 16时46分\n病情摘要：\n1、患者陈太斯,男，76岁，以“反复胸闷、气促1年，加重4天。”为主诉入院。既往“高血压、糖尿病”病史。3月前因“多发性脑梗死（右侧额 顶枕颞岛叶）”于我院神经内科住院诊治，查颅脑高分辨率MRI：1、右侧额顶枕颞岛叶散在脑梗塞（急性-亚急性期），建议 治疗后复查。2、余脑腔隙性脑梗塞，并轻中度动脉硬化性脑白质变性，中度脑萎缩。3、基底动脉局部小开窗畸形。4、右侧大脑中动脉M1段重度狭窄、闭塞，考虑为动脉粥样硬化斑块所致，相应斑块内出血，局部原位及以远M1-M2段部分管腔内血栓形成可能，部分为慢血流伪影/软脑膜侧支倒灌伪影，建议治疗后复查。5、左侧大脑中动脉M1段及上下干动脉粥样硬化伴斑 块形成，以上干为著，相应n\n会诊申请医师：                               主治以上医师签名： \n会诊意见：\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n会诊医师：              日期：会诊日期\n","meta":{"source_file":"患者数据导出20260109_合并(1).xlsx","sheet":"POP_04_手术记录","row_number":12083},"ingested_at":"2026-01-15T12:51:32.789514+00:00"}},{"_index":"surgery_records","_id":"585d576cb6de5d7a69ee30d521ddc545915edd5a","_score":6.60202,"_ignored":["手术记录.keyword"],"_source":{"数据来源":"TAVR","唯一ID号":"SZPX111000306","就诊流水号":"1705996","手术类型":"日常病程记录","手术记录":"2025-02-25 22:21　　　　　\n　　适才神经内科会诊意见如下，病史敬悉，以\"发现主动脉瓣狭窄1周\"为主诉于2025-02-18 17:03入院。患者1周前于因突发言语含糊，伴呃逆。就诊闽清县医院查：头颅平扫+颅脑MRA:1、桥脑左侧急性脑梗死。2、桥脑、双侧小脑半球、基底节区、半卵圆区、额顶叶腔隙性脑梗塞。3、脑萎缩、脑白 质变性。4、双侧上颌窦、筛窦炎；左侧中、下鼻甲肥大。5、颅脑MRA示：颅内动脉呈硬化样改变。专科查体：神志清楚，言语清晰，双侧瞳孔等大等圆直径2.0mm，对光灵敏，示齿双侧鼻唇沟对称，伸舌尚居中，四肢肌力、肌张力正常，病理征未引出，脑膜刺激征阴性。头颅MRI、MRA示：1、腔隙性脑梗塞，轻度脑萎缩 。2、轻度脑动脉硬化。拟诊：脑干梗死（左侧脑桥）；余同贵科；处理：目前暂无绝对手术禁忌，必要时完善SWI检查，随诊，谢邀。以上意见告知患者本人及 家属，请示上级医师后择期手术治疗。\n 医生签名: \n","meta":{"source_file":"患者数据导出20260109_合并(1).xlsx","sheet":"POP_04_手术记录","row_number":13118},"ingested_at":"2026-01-15T12:51:33.426074+00:00"}}]}}
          // PS C:\dev\TimeManager\Medical-SQL-MCP>
          {
            name: 'elasticsearch_for_case',
            description: 'Search surgical records in Elasticsearch with flexible query options. Supports searching by surgical record content, surgery type, surgeon, anesthesia, etc.',
            inputSchema: {
              type: 'object',
              properties: {
                size: {
                  type: 'number',
                  description: 'Number of results to return (default: 10)',
                  default: 10
                },
                surgical_record: {
                  type: 'string',
                  description: 'Search term for surgical record content (e.g., "脑梗塞", "高血压")',
                },
                surgery_type: {
                  type: 'string',
                  description: 'Type of surgery (e.g., "上级医师常规查房记录", "日常病程记录", "神经内科院内会诊记录")',
                },
                surgery_name: {
                  type: 'string',
                  description: 'Name of the surgery/procedure',
                },
                surgeon: {
                  type: 'string',
                  description: 'Name of the surgeon (手术医师)',
                },
                anesthesiologist: {
                  type: 'string',
                  description: 'Name of the anesthesiologist (麻醉医师)',
                },
                anesthesia_method: {
                  type: 'string',
                  description: 'Anesthesia method (麻醉方式)',
                },
                patient_id: {
                  type: 'string',
                  description: 'Unique patient ID (唯一ID号)',
                },
                visit_id: {
                  type: 'string',
                  description: 'Visit/encounter ID (就诊流水号)',
                },
                data_source: {
                  type: 'string',
                  description: 'Data source (数据来源: TEER, TAVR, TAVI, etc.)',
                },
                blood_transfusion: {
                  type: 'string',
                  description: 'Whether blood transfusion was performed (有无输血)',
                },
                heparin_dosage: {
                  type: 'string',
                  description: 'Heparin dosage (肝素用量)',
                },
                contrast_dosage: {
                  type: 'string',
                  description: 'Contrast agent dosage (造影剂用量)',
                },
                main_path: {
                  type: 'string',
                  description: 'Main surgical path (主要路径)',
                },
                query_mode: {
                  type: 'string',
                  description: 'Query mode: "match" (default) or "match_phrase" for exact phrase matching',
                  enum: ['match', 'match_phrase'],
                  default: 'match'
                }
              },
              additionalProperties: false
            },
          },

          {
            name: 'search_cases_semantic',
            description: 'Search cases using semantic similarity (RAG). Finds similar cases based on meaning rather than just keywords.',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Natural language query to search for similar cases (e.g., "脑梗塞手术记录", "高血压患者手术")',
                },
                topK: {
                  type: 'number',
                  description: 'Number of results to return (default: 10)',
                  default: 10
                },
                index: {
                  type: 'string',
                  description: 'Filter by Elasticsearch index name (e.g., "surgery_records")',
                },
                surgeryType: {
                  type: 'string',
                  description: 'Filter by surgery type (手术类型)',
                },
                dataSource: {
                  type: 'string',
                  description: 'Filter by data source (数据来源: TEER, TAVR, TAVI, etc.)',
                },
                minScore: {
                  type: 'number',
                  description: 'Minimum similarity score threshold (0.0 to 1.0)',
                }
              },
              required: ['query'],
              additionalProperties: false
            },
          },
          {
            name: 'search_cases_hybrid',
            description: 'Hybrid search combining semantic similarity and keyword matching for better search results.',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Search query for cases',
                },
                topK: {
                  type: 'number',
                  description: 'Number of results to return (default: 10)',
                  default: 10
                },
                semanticWeight: {
                  type: 'number',
                  description: 'Weight for semantic search (0.0 to 1.0, default: 0.7)',
                  default: 0.7
                },
                keywordWeight: {
                  type: 'number',
                  description: 'Weight for keyword search (0.0 to 1.0, default: 0.3)',
                  default: 0.3
                },
                filters: {
                  type: 'object',
                  description: 'Additional filters for search',
                }
              },
              required: ['query'],
              additionalProperties: false
            },
          },
          {
            name: 'get_case_details',
            description: 'Get detailed information about a specific case by ID.',
            inputSchema: {
              type: 'object',
              properties: {
                caseId: {
                  type: 'string',
                  description: 'Unique case ID from Elasticsearch',
                },
                index: {
                  type: 'string',
                  description: 'Elasticsearch index name (default: "surgery_records")',
                  default: 'surgery_records'
                }
              },
              required: ['caseId'],
              additionalProperties: false
            },
          },
        ],
      };
      return response;
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      log.info('MCP: Tool call', {
        tool: request.params.name,
        args: request.params.arguments
      });

      switch (request.params.name) {
        case 'get_current_time': {
          return {
            content: [
              {
                type: 'text',
                text: new Date().toISOString(),
              },
            ],
          };
        }

        case 'search_related_tables': {
          const query = String(request.params.arguments?.query);
          const results = await ragSystem.search(query);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(results, null, 2),
              },
            ],
          };
        }

        case 'search_all_indices': {
          try {
            const query = String(request.params.arguments?.query);
            const size = Number(request.params.arguments?.size) || 10;

            const elastic = getElasticsearchAdapter();
            const results = await elastic.searchAllIndices(query, size);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(results, null, 2),
                },
              ],
            };
          } catch (error: any) {
            log.error('Search all indices failed', error);
            return {
              content: [
                {
                  type: 'text',
                  text: `Error searching all indices: ${error.message}`,
                },
              ],
              isError: true,
            };
          }
        }

        case 'search_in_index': {
          try {
            const indexName = String(request.params.arguments?.indexName);
            const query = String(request.params.arguments?.query);
            const fields = request.params.arguments?.fields as string[] || ['*'];
            const size = Number(request.params.arguments?.size) || 10;

            const elastic = getElasticsearchAdapter();
            const results = await elastic.searchInIndex(indexName, query, fields, size);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(results, null, 2),
                },
              ],
            };
          } catch (error: any) {
            log.error('Search in index failed', error);
            return {
              content: [
                {
                  type: 'text',
                  text: `Error searching in index: ${error.message}`,
                },
              ],
              isError: true,
            };
          }
        }

        case 'list_elasticsearch_indices': {
          try {
            const elastic = getElasticsearchAdapter();
            const indices = await elastic.getAllIndices();

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    indices,
                    count: indices.length,
                    prefix: elastic['defaultIndexPrefix']
                  }, null, 2),
                },
              ],
            };
          } catch (error: any) {
            log.error('List indices failed', error);
            return {
              content: [
                {
                  type: 'text',
                  text: `Error listing indices: ${error.message}`,
                },
              ],
              isError: true,
            };
          }
        }

        case 'query_database': {
          const sql = String(request.params.arguments?.sql);
          log.sql(sql);

          const allowNonSelect = process.env.ALLOW_NON_SELECT_QUERIES === 'true';
          if (!allowNonSelect && !/^\s*select/i.test(sql)) {
            log.error('Non-SELECT query rejected', { sql });
            throw new McpError(ErrorCode.InvalidParams, 'Only SELECT queries are allowed in read-only mode.');
          }

          try {
            const rows = await query(sql);
            log.sql(sql, rows);

            const response = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(rows, null, 2),
                },
              ],
            };
            log.info('MCP: query_database completed', {
              rowCount: Array.isArray(rows) ? rows.length : 'unknown'
            });
            return response;
          } catch (error: any) {
            log.error('SQL execution failed', error);
            return {
              content: [
                {
                  type: 'text',
                  text: `Error executing SQL: ${error.message}`,
                },
              ],
              isError: true,
            };
          }
        }

        case 'schema_ls': {
          const path = String(request.params.arguments?.path || '/');
          log.info('Schema ls called', { path });

          try {
            const tree = await this.ensureTree();
            let result: any = [];

            // Normalize path
            const cleanPath = path.replace(/^\/+|\/+$/g, '');

            if (!tree.root) {
              throw new McpError(ErrorCode.InternalError, 'Virtual file system not initialized');
            }

            // New path-based navigation
            let currentNode = tree.root;

            if (cleanPath !== '') {
              const parts = cleanPath.split('/');
              for (const part of parts) {
                if (!currentNode.children) {
                  throw new McpError(ErrorCode.InvalidParams, `Path not found: ${path}`);
                }
                const found = currentNode.children.find(c => c.name === part);
                if (!found) {
                  throw new McpError(ErrorCode.InvalidParams, `Path segment '${part}' not found in '${currentNode.path}'`);
                }
                currentNode = found;
              }
            }

            if (currentNode.type === 'directory') {
              result = currentNode.children?.map(c => ({
                name: c.name,
                type: c.type,
                path: c.path,
                tableName: c.tableName,
                description: c.description || (c.tableName ? tree.tables[c.tableName]?.llm_description : undefined)
              })) || [];
            } else {
              // It's a file (table), return info about it being a table
              result = [{
                name: currentNode.name,
                type: 'file',
                path: currentNode.path,
                tableName: currentNode.tableName,
                description: currentNode.description
              }];
            }

            return {
              content: [{
                type: 'text',
                text: JSON.stringify(result, null, 2)
              }],
            };
          } catch (error: any) {
            log.error('Schema ls failed', error);
            return {
              content: [{ type: 'text', text: `Error: ${error.message}` }],
              isError: true,
            };
          }
        }

        case 'get_table_schema': {
          const tableName = String(request.params.arguments?.tableName);
          log.info('Get table schema called', { tableName });

          try {
            const tree = await this.ensureTree();
            const table = tree.tables[tableName];

            if (!table) {
              throw new McpError(ErrorCode.InvalidParams, `Table '${tableName}' not found`);
            }

            const result = table.columns.map(c => ({
              name: c.name,
              type: 'column',
              dataType: c.data_type
            }));

            return {
              content: [{
                type: 'text',
                text: JSON.stringify(result, null, 2)
              }],
            };
          } catch (error: any) {
            log.error('Get table schema failed', error);
            return {
              content: [{ type: 'text', text: `Error: ${error.message}` }],
              isError: true,
            };
          }
        }

        case 'elasticsearch_for_case': {
          try {
            const size = Number(request.params.arguments?.size) || 10;
            const surgical_record = request.params.arguments?.surgical_record as string | undefined;
            const surgery_type = request.params.arguments?.surgery_type as string | undefined;
            const surgery_name = request.params.arguments?.surgery_name as string | undefined;
            const surgeon = request.params.arguments?.surgeon as string | undefined;
            const anesthesiologist = request.params.arguments?.anesthesiologist as string | undefined;
            const anesthesia_method = request.params.arguments?.anesthesia_method as string | undefined;
            const patient_id = request.params.arguments?.patient_id as string | undefined;
            const visit_id = request.params.arguments?.visit_id as string | undefined;
            const data_source = request.params.arguments?.data_source as string | undefined;
            const blood_transfusion = request.params.arguments?.blood_transfusion as string | undefined;
            const heparin_dosage = request.params.arguments?.heparin_dosage as string | undefined;
            const contrast_dosage = request.params.arguments?.contrast_dosage as string | undefined;
            const main_path = request.params.arguments?.main_path as string | undefined;
            const query_mode = (request.params.arguments?.query_mode as string) || 'match';

            const elastic = getElasticsearchAdapter();
            const results = await elastic.queryInCaseElasticsearch({
              surgical_record,
              surgery_type,
              surgery_name,
              surgeon,
              anesthesiologist,
              anesthesia_method,
              patient_id,
              visit_id,
              data_source,
              blood_transfusion,
              heparin_dosage,
              contrast_dosage,
              main_path,
              query_mode
            }, size);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(results, null, 2),
                },
              ],
            };
          } catch (error: any) {
            log.error('Elasticsearch for case failed', error);
            return {
              content: [
                {
                  type: 'text',
                  text: `Error searching surgical records: ${error.message}`,
                },
              ],
              isError: true,
            };
          }
        }



        case 'search_cases_semantic': {
          try {
            const query = String(request.params.arguments?.query);
            const topK = Number(request.params.arguments?.topK) || 10;
            const index = request.params.arguments?.index as string | undefined;
            const surgeryType = request.params.arguments?.surgeryType as string | undefined;
            const dataSource = request.params.arguments?.dataSource as string | undefined;
            const minScore = request.params.arguments?.minScore as number | undefined;

            const filters: any = {};
            if (index) filters.index = index;
            if (surgeryType) filters.surgeryType = surgeryType;
            if (dataSource) filters.dataSource = dataSource;
            if (minScore !== undefined) filters.minScore = minScore;

            const results = await caseRAGSystem.search(query, topK, filters);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    query,
                    filters,
                    results,
                    count: results.length
                  }, null, 2),
                },
              ],
            };
          } catch (error: any) {
            log.error('Semantic case search failed', error);
            return {
              content: [
                {
                  type: 'text',
                  text: `Error in semantic case search: ${error.message}`,
                },
              ],
              isError: true,
            };
          }
        }

        case 'search_cases_hybrid': {
          try {
            const query = String(request.params.arguments?.query);
            const topK = Number(request.params.arguments?.topK) || 10;
            const semanticWeight = Number(request.params.arguments?.semanticWeight) || 0.7;
            const keywordWeight = Number(request.params.arguments?.keywordWeight) || 0.3;
            const filters = request.params.arguments?.filters as any;

            const results = await caseRAGSystem.hybridSearch(query, topK, {
              semanticWeight,
              keywordWeight,
              filters
            });

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    query,
                    semanticWeight,
                    keywordWeight,
                    results,
                    count: results.length
                  }, null, 2),
                },
              ],
            };
          } catch (error: any) {
            log.error('Hybrid case search failed', error);
            return {
              content: [
                {
                  type: 'text',
                  text: `Error in hybrid case search: ${error.message}`,
                },
              ],
              isError: true,
            };
          }
        }

        case 'get_case_details': {
          try {
            const caseId = String(request.params.arguments?.caseId);
            const index = String(request.params.arguments?.index || 'surgery_records');

            const details = await caseRAGSystem.getCaseDetails(caseId, index);

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    caseId,
                    index,
                    details
                  }, null, 2),
                },
              ],
            };
          } catch (error: any) {
            log.error('Failed to get case details', error);
            return {
              content: [
                {
                  type: 'text',
                  text: `Error getting case details: ${error.message}`,
                },
              ],
              isError: true,
            };
          }
        }

        case 'get_case_rag_stats': {
          try {
            const stats = caseRAGSystem.getStats();
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(stats, null, 2),
                },
              ],
            };
          } catch (error: any) {
            log.error('Failed to get case RAG stats', error);
            return {
              content: [
                {
                  type: 'text',
                  text: `Error getting case RAG stats: ${error.message}`,
                },
              ],
              isError: true,
            };
          }
        }

        // case 'clear_case_cache': {
        //   try {
        //     caseRAGSystem.clearCache();
        //     return {
        //       content: [
        //         {
        //           type: 'text',
        //           text: JSON.stringify({
        //             message: 'Case embeddings cache cleared',
        //             status: 'cleared',
        //             note: 'Run index_all_cases to rebuild embeddings'
        //           }, null, 2),
        //         },
        //       ],
        //     };
        //   } catch (error: any) {
        //     log.error('Failed to clear case cache', error);
        //     return {
        //       content: [
        //         {
        //           type: 'text',
        //           text: `Error clearing case cache: ${error.message}`,
        //         },
        //       ],
        //       isError: true,
        //     };
        //   }
        // }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
      }
    });
  }

  async run() {
    const app = express();
    app.use(cors());

    app.use((req, res, next) => {
      if (req.path === '/messages') {
        next();
      } else {
        express.json({ limit: '10mb' })(req, res, next);
      }
    });

    app.use((req, res, next) => {
      if (req.path !== '/health') {
        if (req.path !== '/messages') {
          log.request(`${req.method} ${req.path}`, req.body);
        } else {
          log.request(`${req.method} ${req.path}`, { note: 'Body logging handled by transport' });
        }
      }
      next();
    });

    app.get('/sse', async (req, res) => {
      log.info('New SSE connection initiated');
      this.transport = new SSEServerTransport('/messages', res);
      const originalSend = this.transport.send.bind(this.transport);
      this.transport.send = async (message: JSONRPCMessage) => {
        log.response('JSON-RPC Response', message);
        return originalSend(message);
      };

      log.info('Connecting transport to server...');
      await this.server.connect(this.transport);

      const originalOnMessage = this.transport.onmessage;
      if (originalOnMessage) {
        this.transport.onmessage = (message: JSONRPCMessage) => {
          log.request('JSON-RPC Request', message);
          return originalOnMessage(message);
        };
      }

      log.info('Transport connected');
    });

    app.post('/messages', async (req, res) => {
      if (!this.transport) {
        log.error('Received message but no active transport');
        res.status(400).send('No active connection');
        return;
      }
      log.info('Handling JSON-RPC message');
      await this.transport.handlePostMessage(req, res);
    });

    // Health check
    app.get('/health', (req, res) => {
      res.json({ status: 'ok', server: 'medical-sql-mcp', timestamp: new Date().toISOString() });
    });

    // Initialize schema on startup
    try {
      await this.ensureTree();
    } catch (error) {
      log.error('Failed to initialize schema on startup', error);
    }
    let elastic = getElasticsearchAdapter();
    if (elastic) {
      log.info('Syncing all tables to Elasticsearch on startup...');

      if (process.env.SYNC_ENABLED === 'true') {
        try {
          await elastic.syncAllTablesToElasticsearch();
        } catch (error) {
          log.error('Failed to sync tables to Elasticsearch on startup', error);
        }
      }

    }


    const port = process.env.PORT || 3001;
    app.listen(port, () => {
      log.info(`Medical SQL MCP Server started on port ${port}`);
      log.info(`Health check: http://localhost:${port}/health`);
      log.info(`SSE Endpoint: http://localhost:${port}/sse`);
      log.info(`Messages Endpoint: http://localhost:${port}/messages`);
    });
  }
}

const server = new MedicalMcpServer();
server.run().catch((error) => {
  log.error('Server startup failed', error);
  process.exit(1);
});