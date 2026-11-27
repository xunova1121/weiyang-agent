# 未央 Agent 版：服务器镜像。数据（配置、对话、工作文件夹）放在挂载的 /data 里，镜像里不放任何密钥。
#
# 底子用 Ubuntu 24.04（“运行命令”用的 bubblewrap 沙箱在这个系统上实测过），Node.js 从官方 node 镜像拷过来。
# 国内构建：Docker Hub、Ubuntu 官方源、npm 官方源都可能很慢或连不上，可以换成国内镜像，例如
#   docker build \
#     --build-arg NODE_IMAGE=<镜像源>/library/node:22-bookworm-slim \
#     --build-arg BASE_IMAGE=<镜像源>/library/ubuntu:24.04 \
#     --build-arg APT_MIRROR=https://mirrors.aliyun.com/ubuntu \
#     --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
#     -t weiyang-agent .
ARG NODE_IMAGE=node:22-bookworm-slim
ARG BASE_IMAGE=ubuntu:24.04

FROM ${NODE_IMAGE} AS node

FROM ${BASE_IMAGE}
ARG APT_MIRROR=
ARG NPM_REGISTRY=https://registry.npmjs.org

# bubblewrap + socat：给“运行命令”用的沙箱（两样都要）；ca-certificates：连 DeepSeek 的 HTTPS
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|http://archive.ubuntu.com/ubuntu|$APT_MIRROR|g; s|http://security.ubuntu.com/ubuntu|$APT_MIRROR|g" /etc/apt/sources.list.d/ubuntu.sources; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap socat ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node -v && npm -v

WORKDIR /app
COPY package.json package-lock.json ./
# SDK 会把 musl（Alpine）版的程序也装上；这里是 Ubuntu（glibc），用不到，删掉省 300 多 MB
RUN npm ci --omit=dev --registry="$NPM_REGISTRY" \
 && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-*-musl \
 && npm cache clean --force
COPY server ./server
COPY web ./web

# 镜像自带的普通用户 ubuntu（uid 1000）运行，不用 root
RUN mkdir -p /data && chown ubuntu:ubuntu /data
ENV DATA_DIR=/data HOST=0.0.0.0 PORT=8787 NODE_ENV=production
VOLUME /data
USER ubuntu
EXPOSE 8787
CMD ["node", "server/main.mjs"]
