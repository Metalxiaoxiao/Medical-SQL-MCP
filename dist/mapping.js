"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildVirtualTree = buildVirtualTree;
exports.organizeTablesIntoPaths = organizeTablesIntoPaths;
const db_1 = require("./db");
const llm_logger_1 = require("./llm-logger");
async function buildVirtualTree(database) {
    const { tables, columns, fks } = await (0, db_1.introspect)(database);
    const tablesArray = tables;
    const db = (tablesArray[0] && tablesArray[0].TABLE_SCHEMA) || database || process.env.DB_DATABASE || 'database';
    const tableMap = {};
    for (const t of tablesArray) {
        tableMap[t.TABLE_NAME] = { name: t.TABLE_NAME, comment: t.TABLE_COMMENT || '', columns: [] };
    }
    for (const c of columns) {
        const tbl = tableMap[c.TABLE_NAME];
        if (!tbl)
            continue;
        tbl.columns.push({ name: c.COLUMN_NAME, data_type: c.DATA_TYPE, key: c.COLUMN_KEY });
    }
    // Use LLM to analyze and categorize tables if API key is configured
    let useTableList = Object.values(tableMap);
    if (process.env.OPENAI_API_KEY) {
        try {
            console.log('Using LLM to analyze database schema...');
            useTableList = await categorizeTablesWithLLM(Object.values(tableMap));
        }
        catch (err) {
            console.warn('Failed to use LLM for schema analysis, falling back to heuristics:', err);
        }
    }
    const categories = {};
    for (const tbl of useTableList) {
        const cat = tbl.llm_category || 'other';
        categories[cat] = categories[cat] || [];
        categories[cat].push(tbl);
    }
    let root;
    if (process.env.OPENAI_API_KEY) {
        try {
            console.log('Using LLM to build path structure...');
            root = await organizeTablesIntoPaths(useTableList);
        }
        catch (err) {
            console.warn('Failed to build path structure with LLM:', err);
        }
    }
    return { database: db, categories, tables: tableMap, root };
}
async function organizeTablesIntoPaths(tables) {
    const tableSummaries = tables.map(t => `${t.name}: ${t.llm_description || t.comment || ''}`).join('\n');
    const system = `你是一个信息架构师。请将以下数据库表组织成一个类似文件系统的层级结构，以便于查找。
规则：
1. 根节点 name 为 "/"，type 为 "directory"。
2. 根据语义将表分组到文件夹中。
3. 每一层（每个文件夹内）的元素数量尽量控制在 5 个以内。如果数量过多，请创建子文件夹。
4. 返回一个 JSON 对象，表示根目录的结构。
5. 仅返回 JSON，不要有其他文字。

返回格式示例：
{
  "name": "/",
  "type": "directory",
  "children": [
    {
      "name": "财务管理",
      "type": "directory",
      "children": [
        { "name": "收费表", "type": "file", "tableName": "charges", "description": "..." }
      ]
    }
  ]
}`;
    const userPrompt = `请组织以下表：\n${tableSummaries}`;
    const response = await (0, llm_logger_1.callOpenAIChatWithLogging)(system, userPrompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        throw new Error('LLM response did not contain valid JSON');
    }
    const root = JSON.parse(jsonMatch[0]);
    // Post-process to add paths
    function addPaths(node, parentPath) {
        node.path = parentPath === '/' ? (node.name === '/' ? '/' : `/${node.name}`) : `${parentPath}/${node.name}`;
        if (node.children) {
            for (const child of node.children) {
                addPaths(child, node.path);
            }
        }
    }
    addPaths(root, '/');
    // Fix root path if it got messed up
    root.path = '/';
    return root;
}
async function categorizeTablesWithLLM(tables) {
    // Build a schema summary for LLM
    const schemaSummary = tables
        .map((t) => {
        const cols = t.columns.map((c) => `${c.name}(${c.data_type})`).join(', ');
        return `表: ${t.name}\n  列: ${cols}\n  备注: ${t.comment || '无'}`;
    })
        .join('\n\n');
    const system = `你是一个医院数据库架构专家。分析给定的数据库表结构，为每个表分配一个合适的语义分类和描述。
返回格式必须是 JSON 数组，每个元素包含:
{
  "table": "表名",
  "category": "分类名（如：患者信息、诊断、治疗、检查、不良事件、监护等）",
  "description": "表的简短描述（中文）"
}`;
    const userPrompt = `请分析以下医院数据库表结构，为每个表分配适当的语义分类和描述：\n${schemaSummary}\n\n返回 JSON 数组。`;
    const response = await (0, llm_logger_1.callOpenAIChatWithLogging)(system, userPrompt);
    // Parse JSON from response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
        console.warn('LLM response did not contain valid JSON:', response);
        return tables;
    }
    const parsed = JSON.parse(jsonMatch[0]);
    // Merge LLM results back into tables
    const tableMap = new Map(tables.map((t) => [t.name, t]));
    for (const item of parsed) {
        const tbl = tableMap.get(item.table);
        if (tbl) {
            tbl.llm_category = item.category;
            tbl.llm_description = item.description;
        }
    }
    return tables;
}
