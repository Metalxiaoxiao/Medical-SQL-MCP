# Medical SQL MCP Server Documentation

本文档描述了 Medical SQL MCP 服务器的 Model Context Protocol (MCP) 接口。

## MCP 服务器信息

- **名称**: medical-sql-mcp
- **版本**: 0.1.0
- **协议**: Model Context Protocol
- **传输**: stdio / SSE

## Resources (资源)

### `medical://schema`

返回数据库的虚拟树结构，包含 LLM 分析的表分类和描述。

- **URI**: `medical://schema`
- **MIME Type**: `application/json`
- **描述**: 医院数据库的语义化虚拟树结构

## Tools (工具)

### `schema_ls`

浏览数据库的虚拟文件系统。这是探索数据库结构的第一步。

**参数**:
- `path` (string, optional): 要列出的路径（例如 `/` 或 `/患者服务`）。默认为根目录 `/`。

**示例**:
```json
{
  "path": "/患者服务"
}
```

**返回**: 目录下的文件（表）和子目录列表。

### `get_table_schema`

获取指定表的详细列信息（字段名、类型等）。

**参数**:
- `tableName` (string, required): 要查看的表名。

**示例**:
```json
{
  "tableName": "patients"
}
```

**返回**: 表的列定义列表。

### `query_database`

执行 SQL 查询。

**注意**: 
- 在执行查询前，**必须**先使用 `schema_ls` 和 `get_table_schema` 探索数据库结构。
- 默认情况下仅允许 `SELECT` 查询。可以通过环境变量 `ALLOW_NON_SELECT_QUERIES=true` 开启写操作权限。

**参数**:
- `sql` (string, required): 要执行的 SQL 语句。

**示例**:
```json
{
  "sql": "SELECT * FROM patients LIMIT 10"
}
```

**返回**: JSON 格式的查询结果行。

### `get_current_time`

获取当前系统时间。

**注意**: 当用户的查询涉及相对时间（如“今天”、“昨天”、“上个月”、“近三年”）时，**必须**先调用此工具获取基准时间。

**参数**: 无

**返回**: ISO 格式的当前时间字符串。

## 环境变量

| 变量名 | 必需 | 说明 | 示例 |
|--------|------|------|------|
| `DB_HOST` | ✓ | MySQL 服务器地址 | `127.0.0.1` |
| `DB_PORT` |  | MySQL 端口 | `3306` |
| `DB_USER` | ✓ | 数据库用户名 | `root` |
| `DB_PASSWORD` |  | 数据库密码 | `password123` |
| `DB_DATABASE` | ✓ | 数据库名 | `hospital_db` |
| `OPENAI_API_KEY` | ✓ | OpenAI/兼容 API 密钥 (用于生成 Schema 路径) | `sk-...` |
| `OPENAI_BASE_URL` |  | API 端点 | `https://api.openai.com/v1` |
| `ALLOW_NON_SELECT_QUERIES` | | 是否允许非 SELECT 查询 (true/false) | `false` |

## 使用流程示例

1. **探索结构**: 调用 `schema_ls` 查看有哪些业务分类（如 `/患者服务`, `/医疗操作`）。
2. **查找表**: 调用 `schema_ls` (path="/患者服务") 找到 `patients` 表。
3. **查看定义**: 调用 `get_table_schema` (tableName="patients") 查看字段。
4. **获取时间**: 如果查询涉及时间，调用 `get_current_time`。
5. **执行查询**: 构造 SQL 并调用 `query_database`。
