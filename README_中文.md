# Caption Annotation App v12

这是一个本地运行的图片 caption 人工标注系统，包含 React 前端、FastAPI 后端和 SQLite 数据库。

## v9 新功能

- 在 caption 中拖动选词后，会立刻显示当前属性颜色的预览，不需要等到点击保存才显示颜色。
- 点击 `Save selected-word annotation` 后，预览会变成正式标注记录。
- 点击彩色标注词，会弹出属性、用户、选中文本和 note 信息。
- 弹窗里可以擦除当前用户自己的标注。
- 增加 `Erase` 橡皮擦按钮：可以清除当前误选，或擦除与当前选择重叠的本人标注。
- `Original Caption` 增加搜索框，搜索关键词会在 caption 内以黄色高亮显示。
- caption 框固定高度，并有明显竖向滚动条，可以在框内上下滚动查看全文。
- caption 可以调字号，也可以点击 `Edit` 后直接编辑并保存。
- `Modification / annotation note` 改为可滚动的多行输入框，长 note 可以上下滚动查看。
- `Attributes` 增加搜索框，可以按标签名检索。
- 点击属性前面的颜色圆点可以直接选颜色。
- 属性支持编辑名称和颜色。
- 属性列表自身带竖向滚动条。
- 属性列表支持调字号和 Compact / Comfort 显示模式。
- 新增属性区域改为更宽的完整输入区域。
- 支持单张上传图片 + caption。
- 支持上传图片 zip + caption jsonl/json，自动按 image_id 或 image_path 文件名匹配 caption。
- 支持 JSON / CSV 导出。

## 后端启动

```bash
cd /Users/nancy/Downloads/caption-annotation-app-v9/backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

如果创建 `.venv` 比较慢，请等待，不要按 `Ctrl + C`。

如果你之前已经有 v4/v5/v6/v7 的可用 `.venv`，也可以复用它来跑 v9：

```bash
cd /Users/nancy/Downloads/caption-annotation-app-v9/backend
/Users/nancy/Downloads/caption-annotation-app-v7/backend/.venv/bin/python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

## 前端启动

```bash
cd /Users/nancy/Downloads/caption-annotation-app-v9/frontend
npm install
npm run dev
```

然后打开：

```text
http://localhost:5173
```

## 标注流程

1. 登录，例如输入 `user1`。
2. 上传或导入图片和 caption。
3. 在右侧 `Attributes` 选择一个属性，例如 `Object`。
4. 在 `Original Caption` 框里拖动选择文本。
5. 选中文本会立刻显示当前属性颜色的预览。
6. 可在下方 note 中写说明。
7. 点击 `Save selected-word annotation` 保存。
8. 保存后，被标注文本会显示对应颜色。
9. 点击彩色文本可以查看标注详情。
10. 如果标错，可以点击弹窗里的 `Erase this annotation`，或者选择重叠文本后点 `Erase`。

## 批量上传 image zip + caption file

支持 caption 文件为 `.jsonl` 或 `.json`。

系统会优先使用：

```text
image_id
```

如果没有，则使用：

```text
image_path 的文件名
```

caption 字段优先读取：

```text
reference_caption
```

如果没有，则读取：

```text
caption
```

## 让手机或其他电脑访问

后端必须用：

```bash
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

前端启动后会显示 Network 地址，例如：

```text
http://10.4.147.182:5173
```

同一个 Wi-Fi 下的其他设备打开这个地址即可。若打不开，可能是网络开启了设备隔离，可以换手机热点或部署到服务器。

## v10 更新

- 修复 Layout Edit 模式下调整好的宽高，在点击 Finish layout 后被还原的问题。
- Image / Caption / Note / Bottom panel 的大小会保存到浏览器 localStorage，退出编辑模式后仍保持原样。
- 前端依赖版本已固定，重新 `npm install` 即可，不需要手动补装 Vite。


## v11 布局修复说明

- 默认不会再自动进入布局编辑模式。
- Edit layout 每次都会基于上一次保存的布局继续编辑。
- Finish layout 后保持当前布局，不再跳回原始布局。
- Refresh / Reset layout 会恢复原始默认布局并刷新数据。
- 使用新的 localStorage key，避免旧版本保存的坏布局影响新版。

## v12 布局修复说明

- 原始界面保持三段式布局：顶部 Image + Original Caption，第二段 Modification / annotation note，第三段 records / upload data。
- 点击 `Edit layout` 时，会先读取当前页面上真实显示的 panel 宽高，再进入编辑模式，因此不会再跳到旧的错误布局。
- 点击 `Finish layout` 后，会保存当前可见布局；下一次再点 `Edit layout` 会基于上一次完成后的布局继续编辑。
- `Refresh / Reset layout` 会清空新版和旧版保存过的布局缓存，并恢复默认原始布局。
- 取消了 Caption 内部文本框和 Attributes 内部列表在编辑模式下的独立 resize，避免它们互相覆盖、挤压成截图 4 那样的布局。

## v13 布局修复说明

- 默认进入页面时使用原始三段式工作区布局：顶部 Image + Original Caption/Attributes，中间 Modification note，底部 records + upload data。
- 点击 Edit layout 后，会从当前屏幕上的布局开始编辑，不会跳回硬编码的旧布局。
- 点击 Finish layout 后，会把当前可见布局保存为新的基础布局。
- 第二次点击 Edit layout 会基于第一次保存后的布局继续编辑；第三次会基于第二次保存后的布局继续编辑。
- 点击 Refresh 会清除自定义布局并恢复原始默认布局，同时刷新数据。
