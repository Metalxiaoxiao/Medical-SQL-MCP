# Medical SQL MCP Server

这是一个基于 Model Context Protocol (MCP) 的服务器，旨在连接大语言模型 (LLM) 与医疗/医院管理数据库。它允许 AI 助手通过结构化的工具探索数据库架构、执行 SQL 查询，并获取实时数据。

## 核心特性

*   **虚拟文件系统导航 (`schema_ls`)**: 将扁平的数据库表结构转化为语义化的虚拟目录树（例如：`/患者服务/挂号表`），帮助 LLM 更直观地理解业务领域。
*   **智能 Schema 检索 (`get_table_schema`)**: 允许按需获取特定表的详细字段定义，减少上下文占用。
*   **安全可控的 SQL 执行 (`query_database`)**:
    *   支持执行 SQL 查询以获取数据。
    *   **安全模式**: 通过环境变量 `ALLOW_NON_SELECT_QUERIES` 控制是否允许非 `SELECT` 操作（如 `INSERT`, `UPDATE`, `DELETE`），默认开启只读保护。
*   **时间感知 (`get_current_time`)**: 提供精确的服务器当前时间，确保处理“今天”、“近三天”等相对时间查询时的准确性。

## 快速开始

### 前置要求

*   Node.js (v16 或更高版本)
*   MySQL 数据库实例
*   OpenAI API Key (用于首次启动时生成语义化的目录结构)

### 安装

1.  克隆项目并安装依赖：
    ```bash
    npm install
    ```

### 配置

在项目根目录创建 `.env` 文件，配置以下环境变量：

```env
# 数据库连接信息
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_password
DB_DATABASE=hospital_management

# MCP 服务器端口
PORT=3000

# OpenAI 配置 (用于构建虚拟目录树)
OPENAI_API_KEY=sk-your_key_here
OPENAI_BASE_URL=https://api.openai.com/v1

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

## 项目结构

*   `src/mcp-server.ts`: MCP 服务器入口，定义了工具 (Tools) 和资源 (Resources) 的处理逻辑。
*   `src/mapping.ts`: 负责将数据库元数据转换为虚拟文件系统树结构。
*   `src/db.ts`: MySQL 数据库连接池封装。
*   `src/llm-logger.ts`: LLM 调用日志记录。
*   `schema-cache.json`: 缓存生成的虚拟目录结构，避免重复调用 LLM 生成。

## 注意事项

*   首次运行时，系统会读取数据库表结构并调用 LLM 生成语义化路径，这可能需要几秒钟，结果会被缓存到 `schema-cache.json`。
*   建议始终保持 `ALLOW_NON_SELECT_QUERIES=false` 以确保数据安全，除非你明确需要 AI 修改数据。

