# Medical SQL MCP Server

这是一个基于 Model Context Protocol (MCP) 的服务器，旨在连接大语言模型 (LLM) 与医疗/医院管理数据库。它允许 AI 助手通过结构化的工具探索数据库架构、执行 SQL 查询，并获取实时数据。

## 核心特性

*   **虚拟文件系统导航 (`schema_ls`)**: 将扁平的数据库表结构转化为语义化的虚拟目录树（例如：`/患者服务/挂号表`），帮助 LLM 更直观地理解业务领域。
*   **智能 Schema 检索 (`get_table_schema`)**: 允许按需获取特定表的详细字段定义，减少上下文占用。
*   **安全可控的 SQL 执行 (`query_database`)**:
    *   支持执行 SQL 查询以获取数据。
    *   **安全模式**: 通过环境变量 `ALLOW_NON_SELECT_QUERIES` 控制是否允许非 `SELECT` 操作（如 `INSERT`, `UPDATE`, `DELETE`），默认开启只读保护。
*   **时间感知 (`get_current_time`)**: 提供精确的服务器当前时间，确保处理“今天”、“近三天”等相对时间查询时的准确性。
*   **RAG 增强搜索 (`search_related_tables`)**: 使用向量嵌入技术，允许通过自然语言搜索相关的数据库表，解决表名不直观的问题。

## 快速开始

### 前置要求

*   Node.js (v16 或更高版本)
*   MySQL 或 PostgreSQL 数据库实例
*   OpenAI API Key (用于首次启动时生成语义化的目录结构)

### 安装

1.  克隆项目并安装依赖：
    ```bash
    npm install
    ```

### 配置

在项目根目录创建 `.env` 文件，配置以下环境变量：

```env
# 数据库类型 (mysql 或 postgres)
DB_TYPE=mysql

# 数据库连接信息
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_DATABASE=hospital_management

# PostgreSQL 特有配置 (可选, 默认为 public)
DB_SCHEMA=public

# Elasticsearch 配置 (可选)
# ELASTICSEARCH_NODE=http://localhost:9200
# ELASTICSEARCH_USERNAME=
# ELASTICSEARCH_PASSWORD=
# ELASTICSEARCH_TLS=false
# ELASTICSEARCH_INDEX_PREFIX=medical_
# ELASTICSEARCH_DEFAULT_INDEX=medical_data

# MCP 服务器端口
PORT=3000

# OpenAI 配置 (用于构建虚拟目录树和 RAG)
OPENAI_API_KEY=sk-your_key_here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini

# RAG 配置 (可选，支持本地模型)
# 如果使用本地模型 (如 Ollama)，请设置 EMBEDDING_MODEL
EMBEDDING_MODEL=text-embedding-3-small
# 如果 Embedding 服务与 Chat 服务不同 (例如 Chat 用 OpenAI, Embedding 用 Ollama)，可单独配置：
# EMBEDDING_API_KEY=sk-...
# EMBEDDING_BASE_URL=http://localhost:11434/v1

# 安全配置
# false: 仅允许 SELECT 查询 (推荐)
# true: 允许所有 SQL 操作
ALLOW_NON_SELECT_QUERIES=false
```

### 运行

**开发模式：**
```bash
npm run dev
```

**构建并运行：**
```bash
npm run build
npm start
```

## 工具列表 (MCP Tools)

| 工具名称 | 描述 | 参数 |
| :--- | :--- | :--- |
| **`schema_ls`** | 浏览数据库的虚拟文件系统。这是探索数据库结构的第一步。 | `path`: 路径 (默认为 `/`) |
| **`get_table_schema`** | 获取指定表的详细列信息（字段名、类型等）。 | `tableName`: 表名 |
| **`query_database`** | 执行 SQL 查询。请先使用 `schema_ls` 确认表结构。 | `sql`: SQL 语句 |
| **`get_current_time`** | 获取当前系统时间。处理时间相关查询前必须调用。 | 无 |
| **`search_related_tables`** | 使用 RAG 搜索相关表。 | `query`: 搜索关键词 |

## 项目结构

*   `src/mcp-server.ts`: MCP 服务器入口，定义了工具 (Tools) 和资源 (Resources) 的处理逻辑。
*   `src/mapping.ts`: 负责将数据库元数据转换为虚拟文件系统树结构。
*   `src/db.ts`: 数据库连接适配器 (支持 MySQL 和 PostgreSQL)。
*   `src/llm-logger.ts`: LLM 调用日志记录。
*   `schema-cache.json`: 缓存生成的虚拟目录结构，避免重复调用 LLM 生成。

## Elasticsearch 集成

项目现已支持 Elasticsearch 作为数据库后端或辅助搜索引擎，提供全文搜索和高级查询功能。

### 主要功能

1. **Elasticsearch 适配器** - 支持作为主要数据库（设置 `DB_TYPE=elasticsearch`）
2. **数据库同步服务** - 自动将关系数据库数据同步到 Elasticsearch
3. **全文搜索** - 支持模糊搜索、多字段搜索
4. **聚合查询** - 支持统计、分组等高级查询
5. **类SQL查询** - 支持类SQL语法的 Elasticsearch 查询

### 快速使用

```bash
# 安装 Elasticsearch 依赖
npm install @elastic/elasticsearch

# 配置环境变量
DB_TYPE=elasticsearch
ELASTICSEARCH_NODE=http://localhost:9200

# 运行示例
npx ts-node examples/elasticsearch-example.ts
```

### 详细文档

查看 [ELASTICSEARCH-INTEGRATION.md](./ELASTICSEARCH-INTEGRATION.md) 获取完整的使用指南和API文档。

## 医疗反向索引

基于现有的医疗数据库表结构，项目实现了针对病名、药品名、检查名的反向索引功能。

### 主要功能

1. **诊断术语索引** - 从 `patient_info.diagnosis` 字段提取和索引疾病名称
2. **药品术语索引** - 从 `medication_records.medication_name` 字段提取和索引药品名称
3. **检查术语索引** - 从各种检查表（如 `blood_routine_tests`, `outpatient_examination_info` 等）提取和索引检查项目
4. **医疗同义词支持** - 支持疾病、药品、检查项目的同义词映射
5. **模糊搜索** - 支持中文拼音和模糊匹配

### 快速使用

```bash
# 运行医疗反向索引示例
npx ts-node examples/medical-index-example.ts

# 从数据库提取并索引所有医疗术语
import { getReverseMedicalIndexService } from './src/medical-index-service';
const service = getReverseMedicalIndexService();
await service.initializeIndex();
await service.indexAllMedicalTermsFromDatabase();

# 搜索医疗术语
const results = await service.searchMedicalTerms('高血压', ['diagnosis']);
```

### 支持的医疗表

根据 `schema-cache.json` 分析，系统自动识别并索引以下类型的医疗数据：

#### 诊断信息
- `patient_info` 表中的 `diagnosis` 字段（ARRAY类型）

#### 药品信息  
- `medication_records` 表中的 `medication_name` 字段
- `outpatient_prescription` 表中的处方信息

#### 检查信息
- 血液检查：`blood_routine_tests`, `biochemistry_tests`, `hematology_tests` 等
- 体液检查：`urine_routine_tests`, `stool_routine_tests` 等
- 专项检查：`immunology_tests`, `microbiology_tests`, `radioimmunoassay_tests` 等
- 门诊检查：`outpatient_examination_info`, `outpatient_laboratory_test` 等

### 同步配置

使用 `MedicalSyncConfig` 类管理数据库同步配置：

```typescript
import { getMedicalSyncConfig } from './src/medical-sync-config';

const config = getMedicalSyncConfig();
config.createCompleteMedicalSyncConfigs(); // 创建完整医疗同步配置
config.createReverseIndexOptimizedConfigs(); // 创建反向索引优化配置
config.enableAllMedicalConfigs(); // 启用所有医疗配置
```

### 已完成的功能
1. **Elasticsearch集成** - 完整的适配器和同步服务
2. **医疗反向索引** - 病名、药品名、检查名的专业索引
3. **数据同步** - 实时数据库到Elasticsearch同步
4. **测试验证** - 所有功能测试通过


### 快速启动
```bash
# 1. 启动Elasticsearch服务器
cd ElasticSearchServer
.\bin\elasticsearch.bat

# 2. 运行医疗索引示例
npx ts-node examples/medical-index-example.ts

# 3. 测试连接
node test-elasticsearch-connection.js
```

### MCP接口
系统新增了完整的Elasticsearch MCP接口，支持以下工具：

1. **状态检查工具**
   - `elasticsearch_status` - 检查Elasticsearch服务器状态
   - `medical_index_stats` - 获取医疗索引统计

2. **搜索功能工具**
   - `elasticsearch_search` - 全文搜索
   - `elasticsearch_search_medical_terms` - 医疗术语搜索

3. **索引管理工具**
   - `elasticsearch_create_index` - 创建索引
   - `elasticsearch_list_indices` - 列出索引
   - `medical_index_create` - 创建医疗反向索引

4. **数据同步工具**
   - `elasticsearch_sync_table` - 表同步
   - `medical_index_sync_config` - 同步配置

### 详细文档
- `ELASTICSEARCH-INTEGRATION.md` - Elasticsearch集成指南
- `MEDICAL-REVERSE-INDEX-SUMMARY.md` - 医疗反向索引详细说明
- `IMPLEMENTATION-COMPLETE.md` - 完整实施总结
- `MCP-ELASTICSEARCH-API.md` - MCP接口API文档

## 注意事项

*   首次运行时，系统会读取数据库表结构并调用 LLM 生成语义化路径，这可能需要几秒钟，结果会被缓存到 `schema-cache.json`。
*   建议始终保持 `ALLOW_NON_SELECT_QUERIES=false` 以确保数据安全，除非你明确需要 AI 修改数据。
*   Elasticsearch 集成已完全实现并测试通过，可直接用于生产环境。
*   MCP接口已完全集成，可通过标准MCP协议访问所有Elasticsearch功能。

