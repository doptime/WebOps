// go.mod — WebOps V6 Go side (driver + per-app auditors).
//
// 故意只写 module + go 两行。两个外部依赖(chromedp、golang.org/x/sync)以及
// chromedp 间接拖入的 cdproto 等,全部由 `go mod tidy` 扫 import 自动补齐并生成 go.sum。
// 这样不会因为我手写错版本号而坏掉 —— 见 README.md「需要下载的东西」。
//
//   cd webops_v6 && go mod tidy        # 联网一次,拉齐依赖 + 生成 go.sum
//   go run ./apps/coffee-cloze -url http://localhost:3001/?webops=1
//   go run ./driver  (如果你为通用驱动器加了 main 包装)

module webops

go 1.21
