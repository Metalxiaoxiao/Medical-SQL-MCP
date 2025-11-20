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
import { callOpenAIChatWithLogging } from './llm-logger';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';

dotenv.config();

// Enhanced Logging utility
const log = {
  info: (message: string, data?: any) => {
    console.error(`[INFO] ${new Date().toISOString()} - ${message}`);
    if (data) console.error(JSON.stringify(data, null, 2));
  },
  request: (endpoint: string, data?: any) => {
    console.error(`[REQUEST] ${new Date().toISOString()} - ${endpoint}`);
    if (data) console.error('Request data:', JSON.stringify(data, null, 2));
  },
  response: (endpoint: string, data?: any) => {
    console.error(`[RESPONSE] ${new Date().toISOString()} - ${endpoint}`);
    if (data) {
      // Truncate large responses for readability
      const serialized = JSON.stringify(data, null, 2);
      if (serialized.length > 2000) {
        console.error(`Response data (truncated): ${serialized.substring(0, 2000)}...`);
      } else {
        console.error('Response data:', serialized);
      }
    }
  },
  llm: (phase: string, data?: any) => {
    console.error(`[LLM] ${new Date().toISOString()} - ${phase}`);
    if (data) console.error(JSON.stringify(data, null, 2));
  },
  error: (message: string, error?: any) => {
    console.error(`[ERROR] ${new Date().toISOString()} - ${message}`);
    if (error) console.error(error);
  },
  sql: (query: string, result?: any) => {
    console.error(`[SQL] ${new Date().toISOString()} - Executing: ${query}`);
    if (result) {
      console.error(`[SQL] Result: ${Array.isArray(result) ? result.length + ' rows' : 'unknown'}`);
    }
  }
};

const SCHEMA_CACHE_FILE = path.join(process.cwd(), 'schema-cache.json');

class MedicalMcpServer {
  private server: Server;
  private tree: VirtualTree | null = null;
  private transport: SSEServerTransport | undefined;

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
    
    // Error handling
    this.server.onerror = (error) => log.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      log.info('Shutting down MCP Server');
      await this.server.close();
      process.exit(0);
    });
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
      const response = {
        tools: [
          {
            name: 'query_database',
            description: (allowNonSelect 
              ? 'Execute a SQL query against the hospital database.' 
              : 'Execute a read-only SQL query (SELECT only) against the hospital database.') +
              ' IMPORTANT: You MUST use the `schema_ls` tool to explore the database structure and find relevant tables BEFORE running any queries.',
            inputSchema: {
              type: 'object',
              properties: {
                sql: {
                  type: 'string',
                  description: allowNonSelect 
                    ? 'The SQL statement to execute' 
                    : 'The SQL SELECT statement to execute',
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
            description: 'List the contents of the virtual file system for the database schema. This is the entry point for database exploration. Use this tool first to understand the data structure.',
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
        ],
      };
      log.info('MCP: Tools listed', { count: response.tools.length });
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

        case 'ask_database': {
          const question = String(request.params.arguments?.question);
          log.info('Processing natural language question', { question });
          
          if (!process.env.OPENAI_API_KEY) {
            throw new McpError(ErrorCode.InvalidRequest, 'OPENAI_API_KEY not configured');
          }

          try {
            const t = await this.ensureTree();
            // Build schema summary
            const schemaParts: string[] = [];
            for (const [name, table] of Object.entries(t.tables)) {
              const cols = table.columns.map((c) => c.name + ':' + c.data_type).slice(0, 20);
              const desc = (table as any).llm_description || '';
              schemaParts.push(`${name}(${cols.join(', ')}) - ${desc}`);
            }
            const schemaText = schemaParts.slice(0, 50).join('\\n');

            const system = `你是一个擅长把中文自然语言转换为 MySQL SELECT 语句的助手。仅返回 SQL（不要使用分号），不要添加解释。数据库 schema 如下（表名、列名:数据类型、表描述）：\\n${schemaText}\\n`;
            const userPrompt = `请根据下面的用户请求生成 SELECT SQL，尽量使用表中已有列名，不要使用任何表或列不存在的名称：\\n用户请求：${question}`;
            
            const completion = await callOpenAIChatWithLogging(system, userPrompt);
            const sql = completion.trim().replace(/;$/,'');
            
            log.info('Generated SQL from natural language', { sql });

            if (!/^\s*select/i.test(sql)) {
              log.error('LLM generated non-SELECT SQL', { sql });
              return {
                content: [{ type: 'text', text: `LLM generated non-SELECT SQL: ${sql}` }],
                isError: true
              };
            }

            const rows = await query(sql);
            log.sql(sql, rows);
            
            const response = {
              content: [
                {
                  type: 'text',
                  text: `Generated SQL: ${sql}\\n\\nResults:\\n${JSON.stringify(rows, null, 2)}`,
                },
              ],
            };
            
            log.info('MCP: ask_database completed', { 
              generatedSQL: sql,
              rowCount: Array.isArray(rows) ? rows.length : 'unknown' 
            });
            
            return response;

          } catch (error: any) {
            log.error('Natural language processing failed', error);
            return {
              content: [{ type: 'text', text: `Error processing request: ${error.message}` }],
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

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
      }
    });
  }

  async run() {
    const app = express();
    app.use(cors());
    
    // Only parse JSON for non-SSE message endpoints
    // The /messages endpoint requires the raw stream for SSEServerTransport
    app.use((req, res, next) => {
      if (req.path === '/messages') {
        next();
      } else {
        express.json({ limit: '10mb' })(req, res, next);
      }
    });
    
    // Request logging middleware
    app.use((req, res, next) => {
      if (req.path !== '/health') {
        // For /messages, body is not parsed here, so we log it via transport interception
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
      
      // Intercept send to log responses
      const originalSend = this.transport.send.bind(this.transport);
      this.transport.send = async (message: JSONRPCMessage) => {
        log.response('JSON-RPC Response', message);
        return originalSend(message);
      };

      log.info('Connecting transport to server...');
      await this.server.connect(this.transport);

      // Intercept onmessage to log requests (must be done after connect)
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