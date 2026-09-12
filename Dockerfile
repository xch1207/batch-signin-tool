# 批量签到工具 - Docker 部署文件
# 适用于 Fly.io、Railway、Docker 主机等

FROM node:20-alpine

# 设置工作目录
WORKDIR /app

# 复制项目文件
COPY package.json ./
COPY server.js ./
COPY config.json ./
COPY public/ ./public/

# 安装依赖（本项目零外部依赖，仅为兼容性）
RUN npm install --production || true

# 暴露端口（云平台会通过环境变量 PORT 覆盖）
EXPOSE 17888

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||17888)+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || exit 1

# 启动服务
CMD ["node", "server.js"]
