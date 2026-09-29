# syntax=docker/dockerfile:1

# ---- deps：安装全部依赖（验收服务需要 devDependencies） ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder：通过完整验收（测试 + 类型检查 + 构建）并产出静态文件 ----
FROM deps AS builder
COPY . .
# 构建期先跑一次验收，镜像本身即代表“已验收”的产物
RUN npm run build

# ---- web：纯静态托管，无后端、无在线服务 ----
FROM nginx:1.27-alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
CMD ["nginx", "-g", "daemon off;"]
