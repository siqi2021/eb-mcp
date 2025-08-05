# 使用官方 Node.js 镜像作为基础镜像
# 指定 Alpine 版本以减小镜像大小
FROM node:20-alpine

# 创建并设置工作目录
WORKDIR /usr/src/app

# 复制 package.json 和 package-lock.json (或 yarn.lock)
COPY package.json ./
COPY yarn.lock ./
# 安装应用程序依赖
RUN yarn

# 复制应用程序源代码
COPY tsconfig.json ./
COPY src/ ./src/

# 暴露应用程序运行的端口（与你的 Express 应用使用的端口一致）
EXPOSE 8080

# 定义环境变量（可选）
# ENV NODE_ENV=production
# ENV PORT=3000

# 启动应用程序
CMD ["yarn", "start"]