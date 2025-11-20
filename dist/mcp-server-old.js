"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const mapping_1 = require("./mapping");
const db_1 = require("./db");
const llm_1 = require("./llm");
const dotenv_1 = __importDefault(require("dotenv"));
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
dotenv_1.default.config();
// Logging utility
const log = {
    info: (message, data) => {
        console.error(`[INFO] ${new Date().toISOString()} - ${message}`);
        if (data)
            console.error(JSON.stringify(data, null, 2));
    },
    request: (endpoint, data) => {
        console.error(`[REQUEST] ${new Date().toISOString()} - ${endpoint}`);
        if (data)
            console.error('Request data:', JSON.stringify(data, null, 2));
    },
    response: (endpoint, data) => {
        console.error(`[RESPONSE] ${new Date().toISOString()} - ${endpoint}`);
        if (data)
            console.error('Response data:', JSON.stringify(data, null, 2));
    },
    llm: (phase, data) => {
        console.error(`[LLM] ${new Date().toISOString()} - ${phase}`);
        if (data)
            console.error(JSON.stringify(data, null, 2));
    },
    error: (message, error) => {
        console.error(`[ERROR] ${new Date().toISOString()} - ${message}`);
        if (error)
            console.error(error);
    }
};
class MedicalMcpServer {
    constructor() {
        this.tree = null;
        this.server = new index_js_1.Server({
            name: 'medical-sql-mcp',
            version: '0.1.0',
        }, {
            capabilities: {
                resources: {},
                tools: {},
            },
        });
        this.setupResourceHandlers();
        this.setupToolHandlers();
        // Error handling
        this.server.onerror = (error) => console.error('[MCP Error]', error);
        process.on('SIGINT', async () => {
            await this.server.close();
            process.exit(0);
        });
    }
    async ensureTree() {
        if (!this.tree) {
            this.tree = await (0, mapping_1.buildVirtualTree)();
        }
        return this.tree;
    }
    setupResourceHandlers() {
        this.server.setRequestHandler(types_js_1.ListResourcesRequestSchema, async () => {
            return {
                resources: [
                    {
                        uri: 'medical://schema',
                        name: 'Database Schema Virtual Tree',
                        mimeType: 'application/json',
                        description: 'The virtual tree structure of the hospital database, categorized by semantics.',
                    },
                ],
            };
        });
        this.server.setRequestHandler(types_js_1.ReadResourceRequestSchema, async (request) => {
            if (request.params.uri === 'medical://schema') {
                const tree = await this.ensureTree();
                return {
                    contents: [
                        {
                            uri: 'medical://schema',
                            mimeType: 'application/json',
                            text: JSON.stringify(tree, null, 2),
                        },
                    ],
                };
            }
            throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidRequest, `Unknown resource: ${request.params.uri}`);
        });
    }
    setupToolHandlers() {
        this.server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: 'query_database',
                        description: 'Execute a read-only SQL query (SELECT only) against the hospital database.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                sql: {
                                    type: 'string',
                                    description: 'The SQL SELECT statement to execute',
                                },
                            },
                            required: ['sql'],
                        },
                    },
                    {
                        name: 'ask_database',
                        description: 'Ask a natural language question about the hospital data. The system will generate SQL and return results.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                question: {
                                    type: 'string',
                                    description: 'The natural language question (e.g., "How many patients with lung cancer?")',
                                },
                            },
                            required: ['question'],
                        },
                    },
                    {
                        name: 'refresh_schema',
                        description: 'Force a refresh of the database schema and virtual tree analysis.',
                        inputSchema: {
                            type: 'object',
                            properties: {},
                        },
                    },
                ],
            };
        });
        this.server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
            switch (request.params.name) {
                case 'query_database': {
                    const sql = String(request.params.arguments?.sql);
                    if (!/^\s*select/i.test(sql)) {
                        throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, 'Only SELECT queries are allowed');
                    }
                    try {
                        const rows = await (0, db_1.query)(sql);
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify(rows, null, 2),
                                },
                            ],
                        };
                    }
                    catch (error) {
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
                    if (!process.env.OPENAI_API_KEY) {
                        throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidRequest, 'OPENAI_API_KEY not configured');
                    }
                    try {
                        const t = await this.ensureTree();
                        // Build schema summary
                        const schemaParts = [];
                        for (const [name, table] of Object.entries(t.tables)) {
                            const cols = table.columns.map((c) => c.name + ':' + c.data_type).slice(0, 20);
                            const desc = table.llm_description || '';
                            schemaParts.push(`${name}(${cols.join(', ')}) - ${desc}`);
                        }
                        const schemaText = schemaParts.slice(0, 50).join('\n');
                        const system = `你是一个擅长把中文自然语言转换为 MySQL SELECT 语句的助手。仅返回 SQL（不要使用分号），不要添加解释。数据库 schema 如下（表名、列名:数据类型、表描述）：\n${schemaText}\n`;
                        const userPrompt = `请根据下面的用户请求生成 SELECT SQL，尽量使用表中已有列名，不要使用任何表或列不存在的名称：\n用户请求：${question}`;
                        const completion = await (0, llm_1.callOpenAIChat)(system, userPrompt);
                        const sql = completion.trim().replace(/;$/, '');
                        if (!/^\s*select/i.test(sql)) {
                            return {
                                content: [{ type: 'text', text: `LLM generated non-SELECT SQL: ${sql}` }],
                                isError: true
                            };
                        }
                        const rows = await (0, db_1.query)(sql);
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: `Generated SQL: ${sql}\n\nResults:\n${JSON.stringify(rows, null, 2)}`,
                                },
                            ],
                        };
                    }
                    catch (error) {
                        return {
                            content: [{ type: 'text', text: `Error processing request: ${error.message}` }],
                            isError: true,
                        };
                    }
                }
                case 'refresh_schema': {
                    try {
                        this.tree = await (0, mapping_1.buildVirtualTree)();
                        return {
                            content: [{ type: 'text', text: 'Schema refreshed successfully.' }],
                        };
                    }
                    catch (error) {
                        return {
                            content: [{ type: 'text', text: `Error refreshing schema: ${error.message}` }],
                            isError: true,
                        };
                    }
                }
                default:
                    throw new types_js_1.McpError(types_js_1.ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
            }
        });
    }
    async run() {
        const app = (0, express_1.default)();
        app.use((0, cors_1.default)());
        app.use(express_1.default.json({ limit: '10mb' }));
        // Direct API endpoints that mirror MCP functionality
        app.get('/api/tools', async (req, res) => {
            log.request('GET /api/tools');
            try {
                const tools = [
                    {
                        name: 'query_database',
                        description: 'Execute a read-only SQL query (SELECT only) against the hospital database.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                sql: {
                                    type: 'string',
                                    description: 'The SQL SELECT statement to execute',
                                },
                            },
                            required: ['sql'],
                        },
                    },
                    {
                        name: 'ask_database',
                        description: 'Ask a natural language question about the hospital data. The system will generate SQL and return results.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                question: {
                                    type: 'string',
                                    description: 'The natural language question (e.g., "How many patients with lung cancer?")',
                                },
                            },
                            required: ['question'],
                        },
                    },
                    {
                        name: 'refresh_schema',
                        description: 'Force a refresh of the database schema and virtual tree analysis.',
                        inputSchema: {
                            type: 'object',
                            properties: {},
                        },
                    },
                ];
                const response = { tools };
                log.response('GET /api/tools', response);
                res.json(response);
            }
            catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
        app.post('/api/tools/call', async (req, res) => {
            log.request('POST /api/tools/call', req.body);
            try {
                const { name, arguments: args } = req.body;
                let result;
                switch (name) {
                    case 'query_database': {
                        log.info(`Executing tool: query_database`);
                        const sql = String(args?.sql);
                        log.info(`SQL Query: ${sql}`);
                        if (!/^\s*select/i.test(sql)) {
                            const errorResponse = { error: 'Only SELECT queries are allowed' };
                            log.response('POST /api/tools/call', errorResponse);
                            return res.status(400).json(errorResponse);
                        }
                        const rows = await (0, db_1.query)(sql);
                        log.info(`Query returned ${Array.isArray(rows) ? rows.length : 'unknown'} rows`);
                        result = { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
                        break;
                    }
                    case 'ask_database': {
                        const question = String(args?.question);
                        if (!process.env.OPENAI_API_KEY) {
                            return res.status(400).json({ error: 'OPENAI_API_KEY not configured' });
                        }
                        const t = await this.ensureTree();
                        const schemaParts = [];
                        for (const [name, table] of Object.entries(t.tables)) {
                            const cols = table.columns.map((c) => c.name + ':' + c.data_type).slice(0, 20);
                            const desc = table.llm_description || '';
                            schemaParts.push(`${name}(${cols.join(', ')}) - ${desc}`);
                        }
                        const schemaText = schemaParts.slice(0, 50).join('\\n');
                        const system = `你是一个擅长把中文自然语言转换为 MySQL SELECT 语句的助手。仅返回 SQL（不要使用分号），不要添加解释。数据库 schema 如下（表名、列名:数据类型、表描述）：\\n${schemaText}\\n`;
                        const userPrompt = `请根据下面的用户请求生成 SELECT SQL，尽量使用表中已有列名，不要使用任何表或列不存在的名称：\\n用户请求：${question}`;
                        const completion = await (0, llm_1.callOpenAIChat)(system, userPrompt);
                        const sql = completion.trim().replace(/;$/, '');
                        if (!/^\\s*select/i.test(sql)) {
                            result = { content: [{ type: 'text', text: `LLM generated non-SELECT SQL: ${sql}` }], isError: true };
                        }
                        else {
                            const rows = await (0, db_1.query)(sql);
                            result = { content: [{ type: 'text', text: `Generated SQL: ${sql}\\n\\nResults:\\n${JSON.stringify(rows, null, 2)}` }] };
                        }
                        break;
                    }
                    case 'refresh_schema': {
                        log.info(`Executing tool: refresh_schema`);
                        this.tree = await (0, mapping_1.buildVirtualTree)();
                        log.info('Schema refresh completed');
                        result = { content: [{ type: 'text', text: 'Schema refreshed successfully.' }] };
                        break;
                    }
                    default:
                        const errorResponse = { error: `Unknown tool: ${name}` };
                        log.response('POST /api/tools/call', errorResponse);
                        return res.status(400).json(errorResponse);
                }
                log.response('POST /api/tools/call', result);
                res.json(result);
            }
            catch (error) {
                res.status(500).json({ error: error.message });
            }
        });
        app.get('/api/resources', async (req, res) => {
            log.request('GET /api/resources');
            try {
                const resources = [
                    {
                        uri: 'medical://schema',
                        name: 'Database Schema Virtual Tree',
                        mimeType: 'application/json',
                        description: 'The virtual tree structure of the hospital database, categorized by semantics.',
                    },
                ];
                const response = { resources };
                log.response('GET /api/resources', response);
                res.json(response);
            }
            catch (error) {
                log.error('GET /api/resources failed', error);
                res.status(500).json({ error: error.message });
            }
        });
        app.post('/api/resources/read', async (req, res) => {
            log.request('POST /api/resources/read', req.body);
            try {
                const { uri } = req.body;
                if (uri === 'medical://schema') {
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
                    log.info(`Returning schema tree with ${Object.keys(tree.tables || {}).length} tables`);
                    log.response('POST /api/resources/read', { ...response, contents: [{ ...response.contents[0], text: '[SCHEMA_DATA]' }] });
                    res.json(response);
                }
                else {
                    const errorResponse = { error: `Unknown resource: ${uri}` };
                    log.response('POST /api/resources/read', errorResponse);
                    res.status(404).json(errorResponse);
                }
            }
            catch (error) {
                log.error('POST /api/resources/read failed', error);
                res.status(500).json({ error: error.message });
            }
        });
        // Health check
        app.get('/health', (req, res) => {
            res.json({ status: 'ok', server: 'medical-sql-mcp' });
        });
        const port = process.env.PORT || 3001;
        app.listen(port, () => {
            log.info(`Medical SQL MCP Server started on port ${port}`);
            log.info(`Health check: http://localhost:${port}/health`);
            log.info(`API endpoints:`);
            log.info(`  GET /api/tools - List available tools`);
            log.info(`  POST /api/tools/call - Call a tool`);
            log.info(`  GET /api/resources - List available resources`);
            log.info(`  POST /api/resources/read - Read a resource`);
        });
    }
}
const server = new MedicalMcpServer();
server.run().catch(console.error);
