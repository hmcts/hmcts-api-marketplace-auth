# ---- Base image ----
FROM hmctspublic.azurecr.io/base/node:20-alpine as base

USER root
RUN corepack enable
USER hmcts

COPY --chown=hmcts:hmcts package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=hmcts:hmcts src ./src

# ---- Runtime image ----
FROM base as runtime

EXPOSE 3001

CMD ["node", "src/server.js"]
