#!/bin/bash
# Medical SQL MCP 服务启动脚本
# 用于iFlow集成的开发和测试

# 检查Node.js是否已安装
if ! command -v node &> /dev/null; then
    echo "错误: Node.js 未安装，请先安装Node.js"
    exit 1
fi

# 检查npm是否已安装
if ! command -v npm &> /dev/null; then
    echo "错误: npm 未安装，请先安装npm"
    exit 1
fi

# 检查环境变量文件是否存在
if [ ! -f .env ]; then
    echo "警告: .env 文件不存在，正在创建示例文件..."
    cp .env.example .env
    echo "请编辑 .env 文件并添加必要的配置信息"
    exit 1
fi

# 安装依赖（如果需要）
echo "检查并安装项目依赖..."
npm install

# 启动开发服务器
echo "启动 Medical SQL MCP 服务..."
npm run dev