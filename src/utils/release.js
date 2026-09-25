// 知识变更影响评估与发布门禁：状态常量、门禁/发布判定、影响项状态、统一发布检查、权限判定与留痕工具（均为纯函数，便于测试）
// 流程：编辑者保存新版本后发起门禁（关联受影响的问答引用、缺口工单、共享链接，
// 并统一评估发布检查：评审结论 / 知识保鲜 / 未解决缺口 / 退役关系）→
// 负责人（文档拥有者）逐项确认影响、豁免负责人级检查项并整体确认 → 管理员豁免管理员级检查项后审批放行
// （released：版本发布、引用与链接状态回写、已豁免检查联动回写关联实体）/ 驳回（rejected：退回编辑者）→
// 已放行版本可由管理员回退（rolled_back：版本回退、引用/链接状态还原）。
// 门禁流转中（pending_confirm / pending_approval）候选版本不对问答/搜索/共享访问暴露，
// 对外内容一律为门禁发起时锁定的「已发布版」（doc.release.publishedSnapshot）。
// 统一状态机：检查项随门禁流转重新评估——阻断时把原因回写门禁单（blockedReasons + timeline），
// 外部条件解除后重新评估自动恢复为「已解除」，存续条件可经对应角色豁免（跨角色审批）。
import { ROLE, isGuestUser } from './permission'
import { buildTimelineEntry } from './review'
import { isFreshDue } from './freshness'
import { gapStatusLabel } from './gap'
import { RETIRE } from './retirement'

// 门禁单状态
export const GATE = {
  PENDING_CONFIRM: 'pending_confirm', // 待负责人确认影响：编辑者已提交并关联影响项
  PENDING_APPROVAL: 'pending_approval', // 待管理员审批：负责人已确认影响
  RELEASED: 'released', // 已放行：版本已发布，问答引用切换、链接状态同步
  REJECTED: 'rejected', // 已驳回：管理员审批不通过，版本不发布，编辑者可修改后重新发起
  WITHDRAWN: 'withdrawn', // 已撤回：编辑者在审批完成前主动撤回
  ROLLED_BACK: 'rolled_back' // 已回退：放行后被管理员回退，版本下线
}

// 文档发布状态（挂在 doc.release.state 上）
export const RELEASE_STATE = {
  NORMAL: 'published', // 正常（最新版本即对外版本；无在途门禁）
  GATED: 'gated' // 门禁中：存在待确认/待审批门禁，对外仍展示门禁前已发布版
}

// 影响项类型
export const IMPACT_TYPE = {
  CITATION: 'citation', // 问答引用：本问题的检索结果将受本次版本变更影响
  TICKET: 'ticket', // 缺口工单：以该文档为答案来源/关联文档
  SHARE: 'share' // 共享链接：访客/成员凭链接访问本文档
}

// 影响项状态（随门禁流转回写；rejected/withdrawn/rollback 后影响项回到门禁前状态）
export const IMPACT = {
  PENDING: 'pending', // 待负责人确认
  CONFIRMED: 'confirmed', // 负责人已确认该影响可接受
  RELEASED: 'released', // 门禁放行后已生效（引用切新版 / 链接同步 / 工单来源已指向新版）
  REVERTED: 'reverted' // 门禁回退后已还原到门禁前状态
}

// ---- 统一发布检查（评审结论 / 知识保鲜 / 未解决缺口 / 退役关系）----

// 检查维度（随门禁单 checks 持久化，随流转重新评估）
export const CHECK_TYPE = {
  REVIEW: 'review', // 评审结论：流转中的评审单（不可豁免）/ 最近一次评审结论为驳回
  FRESHNESS: 'freshness', // 知识保鲜：复核单待整改/被驳回/送审中，或复核周期已到点
  GAP: 'gap', // 未解决缺口：关联本文档且未解决（处理中/送审中）的缺口工单
  RETIREMENT: 'retirement' // 退役关系：本文档正作为他人在途/生效退役的替代文档
}

// 检查项状态
export const CHECK = {
  BLOCKED: 'blocked', // 阻断中：须先解除条件，或经对应角色豁免
  WAIVED: 'waived', // 已豁免：对应角色确认风险可接受（跨角色审批留痕）
  PASS: 'pass' // 已解除：条件已消除（重新评估后的状态恢复，保留留痕）
}

// 豁免所需角色（跨角色审批）：owner=文档负责人（或管理员）；admin=仅管理员；null=不可豁免，须先解除条件
export const CHECK_ROLE = { OWNER: 'owner', ADMIN: 'admin' }

export function gateStatusLabel(status) {
  return {
    pending_confirm: '待负责人确认',
    pending_approval: '待管理员审批',
    released: '已放行发布',
    rejected: '已驳回',
    withdrawn: '已撤回',
    rolled_back: '已回退'
  }[status] || status
}

export function gateStatusCls(status) {
  return {
    pending_confirm: 'st-confirm',
    pending_approval: 'st-pending',
    released: 'st-ok',
    rejected: 'st-no',
    withdrawn: 'st-off',
    rolled_back: 'st-rollback'
  }[status] || ''
}

export function impactTypeLabel(type) {
  return { citation: '问答引用', ticket: '缺口工单', share: '共享链接' }[type] || type
}

export function impactStatusLabel(status) {
  return { pending: '待确认', confirmed: '已确认', released: '已随版本发布', reverted: '已随回退还原' }[status] || status
}

// ---- 门禁流转判定 ----

// 门禁是否在流转中（候选版本尚未发布，编辑锁定）
export function isGateOpen(gate) {
  return !!gate && (gate.status === GATE.PENDING_CONFIRM || gate.status === GATE.PENDING_APPROVAL)
}

// 门禁是否等待指定阶段：负责人确认 / 管理员审批
export function isGatePendingConfirm(gate) {
  return !!gate && gate.status === GATE.PENDING_CONFIRM
}
export function isGatePendingApproval(gate) {
  return !!gate && gate.status === GATE.PENDING_APPROVAL
}

// 门禁已放行（候选版本已发布；可回退）
export function isGateReleased(gate) {
  return !!gate && gate.status === GATE.RELEASED
}

// 门禁是否终态（不可再流转）
export function isGateTerminal(gate) {
  return !!gate && [GATE.RELEASED, GATE.REJECTED, GATE.WITHDRAWN, GATE.ROLLED_BACK].includes(gate.status)
}

// ---- 文档发布闸门 ----

// 文档当前是否处于发布门禁中（存在在途门禁；问答/搜索/共享访问只认已发布版）
export function isDocGated(doc, openGate) {
  if (openGate) return true
  return doc?.release?.state === RELEASE_STATE.GATED && !!doc.release?.activeGateId
}

// 文档对外（问答/搜索/共享）可见的内容快照：
// - 门禁中：门禁发起时锁定的已发布快照（候选版本不提前泄露）
// - 正常：文档当前字段
// 返回 { title, body, categoryId, tagIds, visibility }（与 docSnapshot 同构）
export function publishedSnapshot(doc, openGate) {
  if (isDocGated(doc, openGate)) {
    const snap = openGate?.publishedSnapshot || doc?.release?.publishedSnapshot
    if (snap) return { title: snap.title || '', body: snap.body || '', categoryId: snap.categoryId ?? null, tagIds: [...(snap.tagIds || [])], visibility: snap.visibility || 'public' }
  }
  return {
    title: doc?.title || '',
    body: doc?.body || '',
    categoryId: doc?.categoryId ?? null,
    tagIds: [...(doc?.tagIds || [])],
    visibility: doc?.visibility || 'public'
  }
}

// 文档是否可被问答引用：门禁中的候选版本不额外阻断文档（已发布版仍可被引用），
// 这里仅表达「门禁本身不改变引用资格」；问答页仍需叠加保鲜/退役闸门。
// 引用到的具体内容版本由 citationGateVersion 决定。
export function isDocGateCitable(doc, openGate) {
  return !!doc && !!publishedSnapshot(doc, openGate)
}

// 问答引用当前应指向的版本号：
// - 存在在途门禁且引用创建于门禁发起前 → 门禁基线版本（publishedVersion，旧版）
// - 门禁已放行且未回退 → 新版本（gate.version）
// - 无门禁 → null（调用方按文档最新版处理）
// citeAt: 引用产生时刻（ISO），不传时视为当前引用，门禁中一律给旧版
export function citationGateVersion(doc, gate, citeAt) {
  if (!gate) return null
  if (isGateOpen(gate)) return gate.publishedVersion
  if (isGateReleased(gate)) return gate.version
  // rejected/withdrawn/rolled_back：引用保持发布版（回退时发布版即旧版）
  return gate.publishedVersion
}

// ---- 发起 / 确认 / 审批 / 撤回 / 回退资格 ----

// 发起门禁：登录的内容编辑角色（编辑者/管理员），且对文档具备直接写入资格；
// 文档存在在途门禁或评审单时不可发起；候选版本必须新于当前已发布版本。
// ctx: { userId, role, canEditDoc（布尔，已按拥有者/协作者/授权/共享链接/评审锁定判定）, pendingReview, openGate }
export function canSubmitGate(doc, ctx = {}) {
  if (!doc || isGuestUser(ctx.userId)) return false
  if (ctx.role !== ROLE.ADMIN && ctx.role !== ROLE.EDITOR) return false
  if (ctx.pendingReview) return false
  if (isDocGated(doc, ctx.openGate)) return false
  return ctx.canEditDoc === true
}

// 负责人确认影响：文档拥有者本人或管理员；门禁须处于「待负责人确认」
export function canConfirmGate(gate, doc, userId, role) {
  if (!isGatePendingConfirm(gate) || isGuestUser(userId)) return false
  if (role === ROLE.ADMIN) return true
  return !!doc && doc.ownerId === userId
}

// 编辑者撤回门禁：发起人本人（或管理员）；门禁仍在流转中（确认前/待审批均可撤回）
export function canWithdrawGate(gate, userId, role) {
  if (!isGateOpen(gate) || isGuestUser(userId)) return false
  return gate.submittedBy === userId || role === ROLE.ADMIN
}

// 管理员审批（放行/驳回）：仅管理员；门禁须处于「待管理员审批」
export function canDecideGate(gate, userId, role) {
  return isGatePendingApproval(gate) && !isGuestUser(userId) && role === ROLE.ADMIN
}

// 回退已放行版本：仅管理员；门禁须已放行
export function canRollbackGate(gate, userId, role) {
  return isGateReleased(gate) && !isGuestUser(userId) && role === ROLE.ADMIN
}

// ---- 影响项 ----

// 去重生成影响项键（同类型同实体只保留一条）
export function impactKey(type, refId) {
  return type + ':' + refId
}

// 归一化影响项：补齐状态/快照字段，按类型去重（先入为主）
export function normalizeImpacts(items = []) {
  const map = new Map()
  for (const it of items) {
    if (!it || !it.type || !it.refId) continue
    const key = impactKey(it.type, it.refId)
    if (map.has(key)) continue
    map.set(key, {
      key,
      type: it.type,
      refId: it.refId,
      title: String(it.title || ''),
      subtitle: String(it.subtitle || ''),
      // 门禁发起时的实体状态快照，回退时据此还原（如共享链接 revokedAt/revokeReason）
      before: it.before && typeof it.before === 'object' ? it.before : null,
      status: IMPACT.PENDING,
      confirmedBy: null,
      confirmedAt: null,
      result: null
    })
  }
  return [...map.values()]
}

// 负责人逐项确认：返回新的影响项数组（不修改入参）
export function markImpactConfirmed(impacts, key, userId, now) {
  return (impacts || []).map((it) =>
    it.key === key && it.status === IMPACT.PENDING
      ? { ...it, status: IMPACT.CONFIRMED, confirmedBy: userId, confirmedAt: now }
      : it
  )
}

// 是否全部影响项均已确认（无影响项时视为确认就绪——允许「无关联影响」的门禁直接确认）
export function allImpactsConfirmed(impacts) {
  return (impacts || []).every((it) => it.status === IMPACT.CONFIRMED || it.status === IMPACT.RELEASED)
}

// 放行时影响项批量置为已生效
export function markImpactsReleased(impacts, resultOf = () => null) {
  return (impacts || []).map((it) => ({ ...it, status: IMPACT.RELEASED, result: resultOf(it) || it.result }))
}

// 回退/驳回/撤回时影响项批量还原为待确认前状态（清空确认与生效痕迹）
export function markImpactsReset(impacts, released) {
  return (impacts || []).map((it) => ({
    ...it,
    status: released ? IMPACT.REVERTED : IMPACT.PENDING,
    confirmedBy: released ? it.confirmedBy : null,
    confirmedAt: released ? it.confirmedAt : null,
    result: released ? it.result : null
  }))
}

// 影响项计数
export function impactCounts(impacts) {
  const c = { total: (impacts || []).length, citation: 0, ticket: 0, share: 0, confirmed: 0 }
  for (const it of impacts || []) {
    if (it.type === IMPACT_TYPE.CITATION) c.citation++
    if (it.type === IMPACT_TYPE.TICKET) c.ticket++
    if (it.type === IMPACT_TYPE.SHARE) c.share++
    if (it.status === IMPACT.CONFIRMED || it.status === IMPACT.RELEASED) c.confirmed++
  }
  return c
}

// ---- 统一发布检查：评估 / 重估合并 / 流转闸门 / 豁免资格 ----

export function checkTypeLabel(type) {
  return { review: '评审结论', freshness: '知识保鲜', gap: '未解决缺口', retirement: '退役关系' }[type] || type
}

export function checkStateLabel(state) {
  return { blocked: '阻断中', waived: '已豁免', pass: '已解除' }[state] || state
}

export function checkApproverLabel(role) {
  return role === CHECK_ROLE.ADMIN ? '需管理员豁免' : role === CHECK_ROLE.OWNER ? '需负责人确认' : '须先解除条件'
}

// 评估发布检查项（纯函数；原始数据由调用方在事务内收集，便于测试）：
// 对评审结论、知识保鲜、未解决缺口、退役关系四个维度生成「阻断中」检查项；无发现即全部通过（不生成项）。
// 返回 [{ key, type, refId, title, detail, state, approverRole, blockedReason, waivedBy, waivedAt, waiveNote, resolvedAt }]
export function evaluateChecks({ doc, pendingReview, openFreshTicket, unresolvedGaps, replacementOf }, now = new Date().toISOString()) {
  const items = []
  const push = (it) => items.push({
    state: CHECK.BLOCKED, waivedBy: null, waivedAt: null, waiveNote: '', resolvedAt: null, ...it
  })

  // ① 评审结论
  if (pendingReview) {
    push({
      key: 'review:pending:' + pendingReview.id, type: CHECK_TYPE.REVIEW, refId: pendingReview.id,
      title: '存在流转中的评审单',
      detail: '评审单完结（审批/撤回）后自动解除',
      approverRole: null,
      blockedReason: '文档存在待审批的评审单，须先完结评审'
    })
  }
  const last = doc?.lastReview
  if (last && last.status === 'rejected') {
    push({
      key: 'review:last-rejected:' + (last.reviewId || 'unknown'), type: CHECK_TYPE.REVIEW, refId: last.reviewId || null,
      title: '最近一次评审结论为「驳回」',
      detail: last.note ? '驳回意见：' + last.note : '需确认本次版本已处理驳回意见',
      approverRole: CHECK_ROLE.OWNER,
      blockedReason: '最近一次评审被驳回，需负责人确认本次版本已处理驳回意见'
    })
  }

  // ② 知识保鲜
  if (openFreshTicket) {
    const t = openFreshTicket
    push({
      key: 'freshness:' + t.id, type: CHECK_TYPE.FRESHNESS, refId: t.id,
      title: '知识保鲜第 ' + t.round + ' 轮复核' +
        (t.status === 'rejected' ? '被驳回，待整改' : t.status === 'submitted' ? '送审中' : '到期，待整改'),
      detail: '复核通过或负责人确认风险后可继续',
      approverRole: CHECK_ROLE.OWNER,
      blockedReason: '知识保鲜复核未结案（问答引用已暂停），需负责人确认继续发布'
    })
  } else if (isFreshDue(doc, now)) {
    push({
      key: 'freshness:due', type: CHECK_TYPE.FRESHNESS, refId: null,
      title: '知识保鲜复核周期已到点',
      detail: '复核单即将生成，完成本轮复核或负责人确认后可继续',
      approverRole: CHECK_ROLE.OWNER,
      blockedReason: '知识保鲜复核周期已到点，需负责人确认继续发布'
    })
  }

  // ③ 未解决缺口（已解决工单列入影响项，不在此重复）
  for (const t of unresolvedGaps || []) {
    push({
      key: 'gap:' + t.id, type: CHECK_TYPE.GAP, refId: t.id,
      title: '未解决缺口：' + (t.question || t.id),
      detail: '工单状态：' + gapStatusLabel(t.status),
      approverRole: CHECK_ROLE.OWNER,
      blockedReason: '关联缺口工单未解决（' + gapStatusLabel(t.status) + '），需负责人确认本次发布不覆盖该缺口'
    })
  }

  // ④ 退役关系（替代链上的版本变更影响已退役文档的引用指向，需管理员确认）
  for (const r of replacementOf || []) {
    const open = r.status === RETIRE.PENDING
    push({
      key: 'retirement:replacement:' + r.id, type: CHECK_TYPE.RETIREMENT, refId: r.id,
      title: '本文档是《' + (r.docTitle || r.docId) + '》的退役替代文档',
      detail: open ? '该退役单待审批，批准后引用将指向本文档' : '已退役文档的引用正指向本文档',
      approverRole: CHECK_ROLE.ADMIN,
      blockedReason: open
        ? '存在以本文档为替代文档的在途退役，版本发布需管理员确认'
        : '本文档承载已退役文档的引用，版本发布需管理员确认'
    })
  }
  return items
}

// 重新评估合并（纯函数）：新一轮评估结果与门禁单上既有检查项合并——
// - 同一条件（key 相同）已被豁免且仍存续：豁免结论持续有效（不重复要求确认）；
// - 条件已消除（新一轮不再出现）：恢复为「已解除」并记录恢复时间（重新评估后的状态恢复，保留留痕）；
// - 新出现的条件：生成新的阻断项。
export function mergeChecks(prevChecks, nextItems, now = new Date().toISOString()) {
  const prevByKey = new Map((prevChecks || []).map((c) => [c.key, c]))
  const out = []
  for (const item of nextItems || []) {
    const old = prevByKey.get(item.key)
    if (old && old.state === CHECK.WAIVED) {
      out.push({ ...item, state: CHECK.WAIVED, waivedBy: old.waivedBy, waivedAt: old.waivedAt, waiveNote: old.waiveNote })
    } else {
      out.push(item)
    }
    prevByKey.delete(item.key)
  }
  for (const old of prevByKey.values()) {
    out.push({ ...old, state: CHECK.PASS, resolvedAt: old.resolvedAt || now })
  }
  return out
}

// 负责人整体确认前：负责人级与不可豁免检查必须全部解除/豁免（管理员级检查留待审批环节）
export function ownerChecksCleared(checks) {
  return (checks || []).every((c) => c.state !== CHECK.BLOCKED || c.approverRole === CHECK_ROLE.ADMIN)
}

// 管理员放行前：全部检查必须解除/豁免
export function allChecksCleared(checks) {
  return (checks || []).every((c) => c.state !== CHECK.BLOCKED)
}

// 当前阻断原因汇总（阻断原因回写门禁单 blockedReasons 用）
export function blockedReasonsOf(checks, now = new Date().toISOString()) {
  return (checks || [])
    .filter((c) => c.state === CHECK.BLOCKED)
    .map((c) => ({ key: c.key, type: c.type, title: c.title, reason: c.blockedReason, approverRole: c.approverRole || null, at: now }))
}

// 豁免资格（跨角色审批）：门禁流转中 + 检查项阻断中 + 维度可豁免 + 当前用户为对应角色
// （owner 级：文档负责人或管理员；admin 级：仅管理员；approverRole 为 null 不可豁免）
export function canWaiveCheck(gate, check, doc, userId, role) {
  if (!isGateOpen(gate) || !check || check.state !== CHECK.BLOCKED || !check.approverRole) return false
  if (isGuestUser(userId)) return false
  if (role === ROLE.ADMIN) return true
  return check.approverRole === CHECK_ROLE.OWNER && !!doc && doc.ownerId === userId
}

// 检查项计数（面板/中心展示用）
export function checkCounts(checks) {
  const c = { total: (checks || []).length, blocked: 0, waived: 0, pass: 0 }
  for (const it of checks || []) {
    if (c[it.state] !== undefined) c[it.state]++
  }
  return c
}

// ---- 问答引用影响推荐（提交门禁时自动勾选）----
// 以问题关键词对目标文档打分，命中（score>0）即视为「本次版本变更可能影响到的问答引用」。
// scoreDoc 由调用方注入（复用 utils/qa.scoreDoc），避免本模块依赖检索实现
export function suggestCitationImpacts({ questions, doc, bodyText, tagNames, scoreDoc }) {
  const out = []
  for (const q of questions || []) {
    const text = String(q.question || '').trim()
    if (!text) continue
    const kws = String(q.keywords || '')
      ? q.keywords
      : text.replace(/[？?！!。，,、；;：:]/g, ' ').trim().split(/\s+/).filter(Boolean)
    const score = scoreDoc(doc, kws, tagNames || [], bodyText || '')
    if (score > 0) {
      out.push({
        type: IMPACT_TYPE.CITATION,
        refId: q.id,
        title: text,
        subtitle: q.subtitle || ('最近提问：' + (q.askedBy || '团队成员'))
      })
    }
  }
  return out
}

// ---- 版本记录上的门禁标记 ----
export function versionGateBadge(v) {
  if (!v?.gate) return null
  const g = v.gate
  if (g.status === GATE.RELEASED) return { text: '门禁放行 v' + g.version, cls: 'ok', gateId: g.gateId }
  if (g.status === GATE.PENDING_CONFIRM) return { text: '待影响确认', cls: 'confirm', gateId: g.gateId }
  if (g.status === GATE.PENDING_APPROVAL) return { text: '待审批放行', cls: 'wait', gateId: g.gateId }
  if (g.status === GATE.REJECTED) return { text: '门禁驳回', cls: 'no', gateId: g.gateId }
  if (g.status === GATE.WITHDRAWN) return { text: '门禁撤回', cls: 'off', gateId: g.gateId }
  if (g.status === GATE.ROLLED_BACK) return { text: '已回退', cls: 'rollback', gateId: g.gateId }
  return null
}

// 门禁留痕动作文案（门禁单 timeline 全程保留）
export function gateTimelineLabel(action) {
  return {
    submit: '提交发布门禁',
    'impact-confirm-item': '逐项确认影响',
    'impact-confirm-all': '整体确认影响',
    approve: '管理员审批放行',
    reject: '管理员审批驳回',
    withdraw: '撤回升版门禁',
    rollback: '管理员回退版本',
    // 统一发布检查（评审结论/知识保鲜/未解决缺口/退役关系）
    'gate-blocked': '流转被阻断 · 阻断原因已回写',
    'gate-resumed': '阻断条件解除 · 恢复流转',
    'check-waive': '豁免发布检查项',
    'gate-recheck': '重新评估发布检查',
    'checks-release': '豁免检查项随放行生效',
    // 放行时的联动结果
    'version-publish': '版本发布 · 问答引用切换至新版',
    'share-sync': '共享链接状态随发布同步',
    // 回退时的联动结果
    'version-revert': '版本回退 · 问答引用恢复旧版',
    'share-restore': '共享链接状态随回退还原',
    'doc-delete': '关联文档已删除，门禁关闭'
  }[action] || action
}

// 构造一条门禁留痕
export function buildGateEntry(action, userId, note, now = new Date().toISOString()) {
  return buildTimelineEntry(action, userId, note, now)
}
