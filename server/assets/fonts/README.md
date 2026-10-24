# 字体目录（剪辑模块字幕渲染 fontsdir）

放置 OFL / 可商用授权字体文件（.otf / .ttf / .ttc），推荐思源黑体（SourceHanSansSC-Regular.otf）。
首个文件（文件名排序）作为 default 字体用于 ASS 字幕与风险尾页 drawtext。
目录为空或环境缺 libass 时，渲染引擎自动降级 mock（字幕直过、尾页纯黑）。
