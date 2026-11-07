# 怎么把它传到 GitHub

传到 GitHub 就两件事：**把整个文件夹放上去**，**让别人能看到**。

不用装 git、不用敲命令，网页就能传。

## 一、先准备

1. 有 GitHub 账号（已经能登录）。
2. 这个文件夹已经在电脑上（就是现在这份 `zhizhong`）。
3. 确认里面没有私人东西：`参考/`、`外库/`、`example/` 这些都在 `.gitignore` 里，不会被传；如果你自己加过别的私人文件，先删掉或移出去。

## 二、在 GitHub 上建空仓库

1. 用浏览器打开 github.com，登录。
2. 右上角 `+` → `New repository`。
3. 按这样填：
   - **Repository name**：`zhizhong`
   - **Description**：`一个能认出自己的记忆结构。五份核心，五层经验，纯文本。`（随便写一句就行）
   - **Public**（公开）——要开源就选这个
   - 下面的 `Add a README file`、`.gitignore`、`license` 都**不要勾**
4. 点 `Create repository`。

现在你有一个空仓库，页面会提示「…or upload an existing file」。

## 三、上传文件夹

1. 点页面上的 `uploading an existing file`。
2. 打开电脑上的 `zhizhong` 文件夹，**全选**里面的文件（README.md、boot.mjs、template、docs、examples、LICENSE、.gitignore），拖进网页的框里。
3. 等它一个个传完（几十个文件，很快）。
4. 下面填一句提交说明，比如 `init: 智种 v0.1`。
5. 点绿色的 `Commit changes`。

传完刷新页面，就能看到 README 显示在仓库首页了。

## 四、如果拖拽不好使

网页上传对文件夹支持一般，可以换个办法：

- **用 GitHub Desktop**（推荐）：下载安装，登录，`File → Add local repository` 选 `zhizhong` 文件夹，然后 `Publish repository`。
- **分几批传**：先传 README.md、boot.mjs、LICENSE、.gitignore，再传 template/、docs/、examples/（在网页里点 `Add file → Upload files`，拖子文件夹）。
- **用命令行**（这台机器还没装 git，装了再说）：

  ```bash
  cd zhizhong
  git init
  git add .
  git commit -m "init: 智种 v0.1"
  git branch -M main
  git remote add origin https://github.com/你的用户名/zhizhong.git
  git push -u origin main
  ```

## 五、传完之后

- 仓库首页会显示 README.md，就是说明书。
- `docs/结构.md`、`docs/命令.md` 在仓库里点开就能看。
- `template/` 是空白模板，别人 `cp -r template my-memory` 就能开始。
- `examples/小灯/` 是一个填好的示例，看长什么样。
- 想改说明文字：点 README.md 右上角的铅笔图标，改完 `Commit changes`。

## 常见问题

**传一半失败了？** 刷新页面重传，已传的不受影响（同文件重复上传会覆盖）。

**提示文件太大？** 单文件超过 100MB 会被拒。这个仓库不会有这么大的文件。

**手机能传吗？** 能，但拖文件夹不方便，最好在电脑上操作。

**想删仓库？** 进入仓库 → `Settings` → 最下面 `Danger Zone` → `Delete this repository`。
