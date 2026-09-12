FROM node:22.23.2-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runtime
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
USER node
ENV HOST=0.0.0.0 PORT=8081
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=3s --start-period=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/main.mjs"]

FROM runtime AS test
USER root
RUN apk add --no-cache openssl
USER node
COPY --chown=node:node tests/fixture.mjs tests/relay.test.mjs tests/tls.test.mjs tests/tls-fixture.mjs ./tests/
CMD ["node", "--test", "tests/relay.test.mjs", "tests/tls.test.mjs"]

FROM runtime AS production
