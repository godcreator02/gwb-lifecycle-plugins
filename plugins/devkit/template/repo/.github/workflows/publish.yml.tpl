# devkit.release 把组装好的包文件挂到 release 上并公开它，这个工作流按文件名的序号依次发到 npmjs。
# 用 trusted publishing（OIDC），不存 token：npmjs 上每个包登记的 trusted publisher 写的就是这个文件名 publish.yml。
# 包文件在本机构建与检查，不在这里构建，所以关掉 provenance（它声称包是在这里构建的）。
name: publish

on:
  release:
    types: [published]

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v5
        with:
          node-version: 24
      - name: 用支持 trusted publishing 的 npm
        run: npm install -g npm@11
      - name: 下载包文件
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release download "${{ github.event.release.tag_name }}" --repo "$GITHUB_REPOSITORY" --pattern '*.tgz' --dir packs
      - name: 按序号发到 npmjs（已经在上面的跳过，重跑时用得上）
        env:
          NPM_CONFIG_PROVENANCE: 'false'
        run: |
          for pack in $(ls ./packs/*.tgz | sort); do
            spec=$(tar -xOzf "$pack" package/package.json | node -e 'const m = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(m.name + "@" + m.version)')
            if npm view "$spec" version --registry https://registry.npmjs.org/ > /dev/null 2>&1; then
              echo "$spec 已经在 npmjs 上，跳过"
              continue
            fi
            npm publish "$pack" --access public --tag latest --registry https://registry.npmjs.org/
          done
