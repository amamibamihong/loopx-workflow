# ADR-0010：初始化必须核验 LoopX required skills、路由与新鲜度

- **状态**：Accepted
- **日期**：2026-11-17
- **关联**：GitHub issue #11、`REQ-SKILL-READY-1`、`REQ-MAIN-1`、`REQ-FAILCLOSED-1`、ADR-0003

## 背景

沙箱装上 LoopX 2.3.0 之后，CLI、控制面和 TypeScript runtime 都可用，但 `loopx doctor` 仍报告 `installed LoopX skills are missing or stale`，并把 `install_freshness.status` 标成 `repair_recommended`。`installed_required_skills` 与 `installed_required_skill_routes` 在 doctor payload 里是 `required: false`，因此 doctor 进程可以退出 0。`scripts/preflight-check.sh` 只检查 `loopx` 是否在 PATH 上，缺失时按 ADR-0003 告警；`scripts/workflow-init.sh` 只要 preflight 返回 0 就打印初始化就绪。CLI 在场被误当成 Agent 技能环境完整。

## 决策

- 本机有 `loopx` 时，preflight 执行 `loopx doctor --format json`，并用 `scripts/loopx-skill-readiness.js` 解读 payload，不把 doctor 的进程退出码当成技能就绪。
- 下列任一成立则 preflight 非 0，并打印该 payload 的 `upgrade_command` 或 `fix`；两者都没有时打印 `loopx workflow-skills --install`、`loopx slash-commands --install` 与 `loopx doctor --format json`：
  - `installed_required_skills` 或 `installed_required_skill_routes` 缺失，或在 `applicable !== false` 时 `ok !== true`；
  - 适用时，`skills` 里有技能 `exists !== true`、`required_phrases !== true` 或 `route_conflict === true`，或技能列表为空；
  - `install_freshness.status` 为 `stale`、`repair_recommended` 或 `missing`，缺少该状态，或 `requires_upgrade === true`；
  - `skill_delivery.status` 为 `repair_recommended`；
  - `loopx doctor` 非 0，或 stdout 不是 JSON 对象。
- 这两项检查 `applicable: false` 时，技能由宿主集成自行交付，preflight 不因此阻断。
- 本机没有 `loopx` 时，preflight 仍只告警。ADR-0003 的这条边界保持不变，避免无 CLI 的仓库无法初始化骨架。
- `workflow-init.sh` 与 `loopx-flow init` 继续调用 preflight，且不得用 `|| true` 吞掉它的退出码。doctor 本身先跑 preflight，因此同一判定也阻断 `loopx-flow doctor`。

## 否决

- **把缺 `loopx` 也升级为 preflight 阻断**：与 ADR-0003 冲突，会让尚未安装 CLI 的仓库无法铺骨架。
- **只看 `loopx doctor` 退出码**：技能检查是 `required: false`，退出码 0 正是这次漏报的原因。
- **初始化时自动执行 `workflow-skills --install`**：安装会改用户技能目录；失败路径只给出命令，由调用者执行。

## 修订

- PRD：新增 `REQ-SKILL-READY-1`；`REQ-FAILCLOSED-1` 与 `REQ-MAIN-1` 指向该判定。
- 设计：第 3 节 `init` / `doctor` 行、第 10 节失败矩阵、第 11 节落点。
- 退役：无。

## 不做什么

- 不把控制面一致性、半迁移残留、API 预算从 WARN 改成阻断（ADR-0007）。
- 不在 doctor 的人类可读输出之外再做第二套技能安装。
- 不修改 LoopX 自身把技能检查标成 `required: false` 的契约。
