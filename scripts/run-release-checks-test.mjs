// 发布门禁统一状态机回归（fake-indexeddb + 真实 store）：
// 评审结论 / 知识保鲜 / 未解决缺口 / 退役关系四维检查纳入门禁流转——
// 覆盖：提交时统一评估生成阻断检查项 → 整体确认/放行被阻断并把原因回写门禁单 →
// 跨角色豁免（负责人级/管理员级/不可豁免）→ 外部条件解除后重新评估自动恢复 →
// 放行时已豁免检查联动回写关联实体 → 驳回后重新发布检查重新评估（豁免不跨门禁携带）→
// 退役关系硬阻断（已退役/退役审批中不可提交门禁）。
// 运行：npm run test:release-checks
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useKbStore } from '@/stores/kb'
import { useGapStore } from '@/stores/gap'
import { useReleaseStore } from '@/stores/release'
import { useReviewStore } from '@/stores/review'
import { uid } from '@/utils/format'
import { GATE, CHECK, CHECK_TYPE, CHECK_ROLE, checkCounts } from '@/utils/release'
import { GAP } from '@/utils/gap'
import { FRESH } from '@/utils/freshness'
import { RETIRE } from '@/utils/retirement'
import { PUBLISH } from '@/utils/review'
import { docSnapshot } from '@/utils/version'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const kb = useKbStore(pinia)
const gap = useGapStore(pinia)
const release = useReleaseStore(pinia)
const reviewStore = useReviewStore(pinia)

const owner = { id: 'u-owner', name: '文档负责人', role: 'editor', avatar: 'FZ' }
const editor = { id: 'u-editor', name: '其他编辑', role: 'editor', avatar: 'QT' }
const admin = { id: 'u-admin', name: '管理员', role: 'admin', avatar: 'GL' }
const viewer = { id: 'u-viewer', name: '只读', role: 'viewer', avatar: 'ZD' }

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}
const nowIso = () => new Date().toISOString()

await db.users.bulkAdd([owner, editor, admin, viewer].map((u) => ({ ...u, email: '', title: '' })))

async function mkDoc(extra = {}) {
  const d = {
    id: uid('doc'), title: '门禁检查文档-' + Math.random().toString(36).slice(2, 7),
    body: '<p>旧正文 Vue 初始化 Dexie 查询 权限模型</p>', categoryId: 'c', tagIds: [], visibility: 'public',
    ownerId: owner.id, editors: [owner.id], publishState: PUBLISH.PUBLISHED, activeReviewId: null,
    createdAt: nowIso(), updatedAt: nowIso(),
    versions: [{ version: 1, savedAt: nowIso(), savedBy: owner.id, note: '初始', snapshot: null }],
    ...extra
  }
  d.versions[0].snapshot = docSnapshot(d)
  await db.docs.add(d)
  await kb.reloadDocs()
  return d
}
const getDoc = (id) => db.docs.get(id)

// 直接在库中保存一个新版本（模拟编辑者保存）
async function saveVersion(docId, patch, by) {
  const d = await db.docs.get(docId)
  const now = nowIso()
  const versions = d.versions
  const next = {
    version: versions.length + 1,
    savedAt: now, savedBy: by.id, note: '编辑文档',
    snapshot: {
      title: patch.title ?? d.title,
      body: patch.body ?? d.body,
      categoryId: patch.categoryId ?? d.categoryId,
      tagIds: patch.tagIds ?? d.tagIds,
      visibility: patch.visibility ?? d.visibility
    }
  }
  await db.docs.update(docId, { ...patch, updatedAt: now, versions: [...versions, next] })
  await kb.reloadDocs()
  return next
}

async function mkGap(docId, question, status = GAP.CLAIMED) {
  const t = {
    id: uid('gap'), question, detail: '', status, createdBy: viewer.id, createdAt: nowIso(),
    claimedBy: owner.id, claimedAt: nowIso(), docId, reviewId: null, groupId: null, resolvedAt: null,
    timeline: [{ action: 'claim', by: owner.id, note: '认领工单', at: nowIso() }]
  }
  await db.gapTickets.add(t)
  await gap.reload()
  return t
}
async function mkResolvedGap(docId, question) {
  const t = {
    id: uid('gap'), question, detail: '', status: GAP.RESOLVED, createdBy: viewer.id, createdAt: nowIso(),
    claimedBy: owner.id, claimedAt: nowIso(), docId, reviewId: null, groupId: null, resolvedAt: nowIso(),
    timeline: [{ action: 'resolve', by: admin.id, note: '审批通过，答案来源已回填', at: nowIso() }]
  }
  await db.gapTickets.add(t)
  await gap.reload()
  return t
}
async function mkFreshTicket(docId, status = FRESH.OPEN) {
  const t = {
    id: uid('fr'), docId, round: 1, status, cycleDays: 30, ruleSource: 'doc', policyId: null,
    dueAt: nowIso(), reviewId: null, submittedBy: null, submittedAt: null,
    decidedBy: null, decidedAt: null, decisionNote: '', createdAt: nowIso(),
    timeline: [{ action: 'due', by: 'system', note: '复核周期到点', at: nowIso() }]
  }
  await db.freshnessTickets.add(t)
  await db.docs.update(docId, {
    freshness: { cycleDays: 30, nextDueAt: t.dueAt, round: 1, activeTicket: t.id, source: 'doc', policyId: null }
  })
  await kb.reloadDocs()
  return t
}
async function mkRetirementToReplacement(replacementDocId, status = RETIRE.APPROVED) {
  const oldDoc = await mkDoc()
  const r = {
    id: uid('ret'), docId: oldDoc.id, docTitle: oldDoc.title, replacementDocId,
    status, initiatedBy: owner.id, decidedBy: status === RETIRE.APPROVED ? admin.id : null,
    reason: '内容合并', createdAt: nowIso(), decidedAt: status === RETIRE.APPROVED ? nowIso() : null,
    timeline: [{ action: 'initiate', by: owner.id, note: '发起退役', at: nowIso() }]
  }
  await db.retirements.add(r)
  return r
}
async function markLastReviewRejected(docId, note = '内容不达标') {
  await db.docs.update(docId, { lastReview: { reviewId: uid('rev'), status: 'rejected', by: admin.id, at: nowIso(), note } })
  await kb.reloadDocs()
}

// ---------- 1. 提交时统一评估：四维检查项生成 + 影响项/检查项分离 ----------
console.log('\n[1] 提交门禁：统一评估四维检查（评审结论/知识保鲜/未解决缺口/退役关系）')
const d1 = await mkDoc()
await saveVersion(d1.id, { body: '<p>新正文 新增鉴权说明</p>' }, owner)
await markLastReviewRejected(d1.id)
const ft1 = await mkFreshTicket(d1.id)
const gapOpen1 = await mkGap(d1.id, '未解决缺口：鉴权链路如何设计?')
const gapDone1 = await mkResolvedGap(d1.id, '已解决缺口：Dexie 怎么查询?')
const ret1 = await mkRetirementToReplacement(d1.id)

let r = await release.submitGate({ docId: d1.id }, owner)
assert(r.status === 'ok', '存在阻断条件时仍可提交门禁（检查项随门禁流转处理）')
const g1 = r.gate
assert((g1.checks || []).length === 4, '四维检查各生成一条阻断检查项')
assert(g1.checks.every((c) => c.state === CHECK.BLOCKED), '检查项初始均为阻断中')
const byType = Object.fromEntries(g1.checks.map((c) => [c.type, c]))
assert(byType[CHECK_TYPE.REVIEW] && byType[CHECK_TYPE.FRESHNESS] && byType[CHECK_TYPE.GAP] && byType[CHECK_TYPE.RETIREMENT], '覆盖评审结论/知识保鲜/未解决缺口/退役关系四个维度')
assert(byType[CHECK_TYPE.RETIREMENT].approverRole === CHECK_ROLE.ADMIN, '退役关系检查需管理员豁免（跨角色审批）')
assert(byType[CHECK_TYPE.GAP].approverRole === CHECK_ROLE.OWNER && byType[CHECK_TYPE.REVIEW].approverRole === CHECK_ROLE.OWNER, '缺口/评审结论检查需负责人确认')
assert(g1.impacts.filter((i) => i.type === 'ticket').length === 1 && g1.impacts[0].refId === gapDone1.id, '已解决缺口仍列为影响项，未解决缺口升级为检查项')

// ---------- 2. 阻断原因回写：整体确认被拦截 ----------
console.log('\n[2] 阻断原因回写：负责人级检查未解除时整体确认被拦截')
r = await release.confirmGate(g1.id, '', editor)
assert(r.status === 'denied', '非负责人不能整体确认')
r = await release.confirmGate(g1.id, '', owner)
assert(r.status === 'unconfirmed', '影响项未逐项确认时整体确认被拒绝')
// 逐项确认影响项后，检查项阻断才生效
for (const it of g1.impacts) {
  const rr = await release.confirmImpact(g1.id, it.key, owner)
  assert(rr.status === 'ok', '负责人逐项确认影响：' + it.type)
}
r = await release.confirmGate(g1.id, '', owner)
assert(r.status === 'blocked' && r.reasons.length === 3, '负责人级检查阻断整体确认（管理员级留待审批环节）')
let gCur = release.gateById(g1.id)
assert((gCur.blockedReasons || []).length === 3 && gCur.blockedStage === 'confirm', '阻断原因已回写门禁单（blockedReasons + 阶段）')
assert(gCur.timeline.some((t) => t.action === 'gate-blocked'), '阻断动作写入留痕时间线')

// ---------- 3. 跨角色豁免 ----------
console.log('\n[3] 跨角色豁免：负责人级/管理员级检查项按角色放行')
r = await release.waiveCheck(g1.id, 'gap:' + gapOpen1.id, '', viewer)
assert(r.status === 'denied', '只读成员不能豁免检查项')
r = await release.waiveCheck(g1.id, 'gap:' + gapOpen1.id, '', editor)
assert(r.status === 'denied', '非负责人编辑者不能豁免负责人级检查项')
r = await release.waiveCheck(g1.id, 'retirement:replacement:' + ret1.id, '', owner)
assert(r.status === 'denied', '负责人不能豁免管理员级检查项（跨角色审批）')
for (const key of g1.checks.filter((c) => c.approverRole === CHECK_ROLE.OWNER).map((c) => c.key)) {
  r = await release.waiveCheck(g1.id, key, '风险已确认', owner)
  assert(r.status === 'ok', '负责人豁免负责人级检查项：' + key.split(':')[0])
}
gCur = release.gateById(g1.id)
assert(checkCounts(gCur.checks).waived === 3 && checkCounts(gCur.checks).blocked === 1, '三项负责人级检查已豁免，管理员级检查仍阻断')
assert((gCur.blockedReasons || []).length === 1, '豁免后阻断原因回写同步收缩')
r = await release.confirmGate(g1.id, '影响与负责人级检查已确认', owner)
assert(r.status === 'ok' && r.gate.status === GATE.PENDING_APPROVAL, '负责人级检查豁免后整体确认放行（管理员级留待审批）')

// ---------- 4. 放行阻断与管理员豁免、放行联动回写 ----------
console.log('\n[4] 管理员级检查阻断放行 → 管理员豁免 → 放行并联动回写关联实体')
r = await release.decideGate(g1.id, 'approve', '', admin)
assert(r.status === 'blocked' && r.reasons.length === 1 && r.reasons[0].type === CHECK_TYPE.RETIREMENT, '管理员级检查未豁免时放行被阻断并回写')
gCur = release.gateById(g1.id)
assert(gCur.blockedStage === 'approve' && gCur.timeline.filter((t) => t.action === 'gate-blocked').length === 2, '放行阻断原因与阶段已回写')
r = await release.waiveCheck(g1.id, 'retirement:replacement:' + ret1.id, '替代链影响已评估', admin)
assert(r.status === 'ok', '管理员豁免管理员级检查项')
r = await release.decideGate(g1.id, 'approve', '同意发布', admin)
assert(r.status === 'ok' && r.approved === true, '全部检查解除/豁免后审批放行成功')
const g1Rel = release.gateById(g1.id)
assert(checkCounts(g1Rel.checks).waived === 4 && !g1Rel.blockedReasons, '放行后检查项全部处于已豁免、阻断回写清空')
assert(g1Rel.timeline.some((t) => t.action === 'checks-release'), '放行留痕记录豁免检查随放行生效')
const gapOpen1After = await db.gapTickets.get(gapOpen1.id)
assert(gapOpen1After.timeline.some((t) => t.action === 'gate-release'), '未解决缺口工单回写「门禁放行（已豁免）」留痕')
const ft1After = await db.freshnessTickets.get(ft1.id)
assert(ft1After.timeline.some((t) => t.action === 'gate-release'), '保鲜复核单回写「门禁放行（已豁免）」留痕')
const ret1After = await db.retirements.get(ret1.id)
assert(ret1After.timeline.some((t) => t.action === 'replacement-release'), '退役单回写「替代文档发布新版本」留痕')

// ---------- 5. 状态恢复：外部条件解除后重新评估 ----------
console.log('\n[5] 状态恢复：外部条件解除后重新评估自动恢复')
const d2 = await mkDoc()
await saveVersion(d2.id, { body: '<p>d2 新内容</p>' }, owner)
const gap2 = await mkGap(d2.id, 'd2 未解决缺口?')
r = await release.submitGate({ docId: d2.id }, owner)
const g2 = r.gate
assert((g2.checks || []).length === 1 && g2.checks[0].state === CHECK.BLOCKED, '未解决缺口生成阻断检查项')
r = await release.confirmGate(g2.id, '', owner)
assert(r.status === 'blocked', '缺口未解决时整体确认被阻断')
// 外部解除：工单被解决
await db.gapTickets.update(gap2.id, { status: GAP.RESOLVED, resolvedAt: nowIso() })
r = await release.recheckGate(g2.id, editor)
assert(r.status === 'denied', '无关编辑者不能触发重新评估')
r = await release.recheckGate(g2.id, owner)
assert(r.status === 'ok' && r.recovered.includes('gap:' + gap2.id), '负责人重新评估后阻断解除（状态恢复）')
const g2After = release.gateById(g2.id)
assert(g2After.checks[0].state === CHECK.PASS && g2After.checks[0].resolvedAt, '检查项恢复为「已解除」并记录恢复时间')
assert(!g2After.blockedReasons && g2After.timeline.some((t) => t.action === 'gate-resumed'), '阻断回写清空并留痕「恢复流转」')
r = await release.confirmGate(g2.id, '', owner)
assert(r.status === 'ok', '阻断解除后整体确认放行')
r = await release.decideGate(g2.id, 'approve', '', admin)
assert(r.status === 'ok' && r.approved, '恢复后管理员审批放行成功')

// ---------- 6. 不可豁免检查：在途评审单 ----------
console.log('\n[6] 不可豁免检查：门禁期间出现在途评审单须先完结')
const d3 = await mkDoc()
await saveVersion(d3.id, { body: '<p>d3 新内容</p>' }, owner)
r = await release.submitGate({ docId: d3.id }, owner)
const g3 = r.gate
assert(!(g3.checks || []).length, '无阻断条件时检查项为空')
// 管理员在门禁期间发起评审（管理员并发通道）
const rv = await reviewStore.submitReview(d3.id, { title: d3.title, body: '<p>评审修订</p>', categoryId: 'c', tagIds: [], visibility: 'public' }, '评审意见', admin)
assert(rv.status === 'ok', '管理员可在门禁期间发起评审')
r = await release.recheckGate(g3.id, owner)
assert(r.status === 'ok' && r.emerged.some((k) => k.startsWith('review:pending:')), '重新评估发现在途评审阻断')
const g3Mid = release.gateById(g3.id)
const pendingCheck = g3Mid.checks.find((c) => c.type === CHECK_TYPE.REVIEW)
assert(pendingCheck.state === CHECK.BLOCKED && !pendingCheck.approverRole, '在途评审为不可豁免阻断项')
r = await release.waiveCheck(g3.id, pendingCheck.key, '', admin)
assert(r.status === 'denied', '不可豁免检查项管理员也不能豁免')
r = await release.confirmGate(g3.id, '', owner)
assert(r.status === 'blocked', '在途评审阻断整体确认')
// 完结评审后恢复
await reviewStore.withdrawReview(rv.review.id, admin)
r = await release.recheckGate(g3.id, owner)
assert(r.status === 'ok' && r.recovered.length === 1, '评审完结后重新评估恢复')
r = await release.confirmGate(g3.id, '', owner)
assert(r.status === 'ok', '恢复后整体确认通过')
r = await release.decideGate(g3.id, 'approve', '', admin)
assert(r.status === 'ok' && r.approved, '恢复后审批放行成功')

// ---------- 7. 驳回后重新发布：检查重新评估（豁免不跨门禁携带） ----------
console.log('\n[7] 驳回后重新发布：检查项重新评估，豁免结论不跨门禁携带')
const d4 = await mkDoc()
await saveVersion(d4.id, { body: '<p>d4 v2 内容</p>' }, owner)
await markLastReviewRejected(d4.id, '需补充鉴权说明')
r = await release.submitGate({ docId: d4.id }, owner)
const g4a = r.gate
assert(g4a.checks.length === 1 && g4a.checks[0].state === CHECK.BLOCKED, '评审驳回结论生成阻断检查项')
await release.waiveCheck(g4a.id, g4a.checks[0].key, '已处理', owner)
await release.confirmGate(g4a.id, '', owner)
r = await release.decideGate(g4a.id, 'reject', '仍需修改', admin)
assert(r.status === 'ok' && !r.approved, '管理员驳回门禁')
// 重新编辑后再次提交：检查项重新评估
await saveVersion(d4.id, { body: '<p>d4 v3 补充后内容</p>' }, owner)
r = await release.submitGate({ docId: d4.id }, owner)
assert(r.status === 'ok', '驳回后可重新提交门禁')
const g4b = r.gate
assert(g4b.checks.length === 1 && g4b.checks[0].state === CHECK.BLOCKED, '重新提交后检查项重新评估（前次豁免不携带）')
await release.waiveCheck(g4b.id, g4b.checks[0].key, '已处理', owner)
r = await release.confirmGate(g4b.id, '', owner)
assert(r.status === 'ok', '重新确认通过')
r = await release.decideGate(g4b.id, 'approve', '', admin)
assert(r.status === 'ok' && r.approved, '重新发布放行成功')
const d4Final = await getDoc(d4.id)
assert(d4Final.body.includes('v3 补充后内容') && d4Final.release.publishedVersion === 3, '重新发布后文档状态恢复为最新发布版')

// ---------- 8. 退役关系硬阻断 ----------
console.log('\n[8] 退役关系硬阻断：已退役/退役审批中的文档不可提交门禁')
const d5 = await mkDoc({ retirement: { id: uid('ret'), status: RETIRE.APPROVED, replacementDocId: 'doc-other', decidedAt: nowIso() } })
await saveVersion(d5.id, { body: '<p>退役文档新内容</p>' }, owner)
r = await release.submitGate({ docId: d5.id }, owner)
assert(r.status === 'retired', '已退役文档提交门禁被拒绝（retired）')
const d6 = await mkDoc()
await saveVersion(d6.id, { body: '<p>在途退役文档新内容</p>' }, owner)
const d6rep = await mkDoc()
await db.retirements.add({
  id: uid('ret'), docId: d6.id, docTitle: d6.title, replacementDocId: d6rep.id,
  status: RETIRE.PENDING, initiatedBy: owner.id, decidedBy: null, reason: '', createdAt: nowIso(), timeline: []
})
r = await release.submitGate({ docId: d6.id }, owner)
assert(r.status === 'in-retirement', '退役审批中的文档提交门禁被拒绝（in-retirement）')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
