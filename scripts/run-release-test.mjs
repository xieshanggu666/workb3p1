// 知识变更影响评估与发布门禁端到端回归（fake-indexeddb + 真实 store）
// 覆盖：编辑者保存新版本后提交门禁（自动关联问答引用/缺口工单/共享链接）→
// 负责人逐项确认影响并整体确认 → 管理员审批放行（版本发布、问答引用切新版、链接状态同步回写）/
// 驳回/撤回（版本不发布、对外保持旧版）→ 管理员回退已放行版本（正文/引用/链接状态还原）→
// 门禁中编辑锁定、问答/搜索/共享访问只认已发布版、文档删除清理门禁。
// 运行：npm run test:release
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useGapStore } from '@/stores/gap'
import { useReleaseStore } from '@/stores/release'
import { useShareStore } from '@/stores/share'
import { uid, makeToken } from '@/utils/format'
import { GATE, RELEASE_STATE, publishedSnapshot, isDocGated } from '@/utils/release'
import { canEditDoc } from '@/utils/permission'
import { isShareActive } from '@/utils/share'
import { GAP } from '@/utils/gap'
import { PUBLISH } from '@/utils/review'
import { docSnapshot } from '@/utils/version'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const kb = useKbStore(pinia)
const auth = useAuthStore(pinia)
const gap = useGapStore(pinia)
const release = useReleaseStore(pinia)
const share = useShareStore(pinia)

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
    id: uid('doc'), title: '门禁文档-' + Math.random().toString(36).slice(2, 7),
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

async function mkCitation(docId, question, version) {
  const c = {
    id: uid('cit'), docId, question, keywords: [], snippet: '', docVersion: version,
    askedBy: viewer.id, score: 5, gateId: null, createdAt: nowIso(), ordinal: 0
  }
  await db.qaCitations.add(c)
  return c
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
async function mkShare(docId, permission = 'view') {
  const s = {
    id: uid('share'), docId, token: makeToken(), permission,
    createdBy: owner.id, createdAt: nowIso(), expiresAt: null, revokedAt: null
  }
  await db.shares.add(s)
  return s
}

// ---------- 1. 提交门禁的资格与关联收集 ----------
console.log('\n[1] 提交门禁：资格校验与影响项自动关联')
const d1 = await mkDoc()
// 先保存新版本（v2，候选）
await saveVersion(d1.id, { body: '<p>新正文 Vue 初始化 Dexie 查询 权限模型 新增鉴权说明</p>' }, editor)
// 预置一条 v1 时期的问答引用、一张已解决缺口工单、一条有效共享链接
const cit1 = await mkCitation(d1.id, '权限模型里有哪些角色?', 1)
const ticket1 = await mkResolvedGap(d1.id, 'Dexie 怎么进行查询?')
const share1 = await mkShare(d1.id, 'view')

let r = await release.submitGate({ docId: d1.id }, null)
assert(r.status === 'guest', '访客不能提交发布门禁')
r = await release.submitGate({ docId: d1.id }, viewer)
assert(r.status === 'denied', '只读成员不能提交发布门禁')
r = await release.submitGate({ docId: d1.id }, owner)
assert(r.status === 'ok' && r.gate.status === GATE.PENDING_CONFIRM, '负责人提交门禁成功，进入待确认影响')
const g1 = r.gate
assert(g1.version === 2 && g1.publishedVersion === 1, '门禁记录候选版本 v2 与已发布版本 v1')
const types = g1.impacts.map((it) => it.type).sort()
assert(types.includes('citation') && types.includes('ticket') && types.includes('share'), '自动关联问答引用/缺口工单/共享链接三类影响项')
assert(g1.impacts.every((it) => it.status === 'pending'), '影响项初始均为待确认')
const d1Gated = await getDoc(d1.id)
assert(isDocGated(d1Gated) === true && d1Gated.release.activeGateId === g1.id, '文档进入门禁态并指向在途门禁')
// 门禁期间对外快照为旧版
const pub = publishedSnapshot(d1Gated, g1)
assert(pub.body.includes('旧正文') && !pub.body.includes('新增鉴权说明'), '门禁中对外内容快照为已发布 v1（候选不泄露）')
// 重复提交被拒绝
r = await release.submitGate({ docId: d1.id }, owner)
assert(r.status === 'duplicate', '同一文档存在在途门禁时不可重复提交')
// 门禁中非管理员不可编辑
assert(canEditDoc(d1Gated, { userId: editor.id, role: 'editor', openGate: g1 }) === false, '门禁中非管理员不可编辑')
assert(canEditDoc(d1Gated, { userId: admin.id, role: 'admin', openGate: g1 }) === true, '门禁中管理员仍可编辑')
// 门禁中创建可编辑共享链接被拒绝（只读链接仍可创建）
const resEditShare = await share.createShare(d1.id, 'edit', 0, editor)
assert(resEditShare.status === 'denied', '门禁中禁止生成可编辑共享链接')

// 无内容差异时拒绝门禁
const d2 = await mkDoc()
r = await release.submitGate({ docId: d2.id }, owner)
assert(r.status === 'no-change', '没有新于发布版的版本时提交门禁被拒绝（no-change）')

// ---------- 2. 负责人确认影响 → 待管理员审批 ----------
console.log('\n[2] 负责人逐项确认影响并整体确认')
// 非负责人/管理员不能确认
r = await release.confirmGate(g1.id, '', editor)
assert(r.status === 'denied', '非负责人不能整体确认影响')
// 未逐项确认时整体确认被拒绝
r = await release.confirmGate(g1.id, '', owner)
assert(r.status === 'unconfirmed', '影响项未逐项确认时整体确认被拒绝')
// 逐项确认
for (const it of g1.impacts) {
  const rr = await release.confirmImpact(g1.id, it.key, owner)
  assert(rr.status === 'ok', '负责人逐项确认：' + it.type)
}
const g1b = release.gateById(g1.id)
assert(g1b.impacts.every((it) => it.status === 'confirmed'), '全部影响项已确认')
// 已确认的项不可重复确认
const rrDup = await release.confirmImpact(g1.id, g1b.impacts[0].key, owner)
assert(rrDup.status === 'changed', '已确认影响项不可重复确认')
r = await release.confirmGate(g1.id, '影响可接受', owner)
assert(r.status === 'ok' && r.gate.status === GATE.PENDING_APPROVAL, '整体确认后进入待管理员审批')

// ---------- 3. 门禁中问答/共享访问只认旧版 ----------
console.log('\n[3] 门禁期间问答/共享访问只展示已发布旧版')
const d1Mid = await getDoc(d1.id)
const pubMid = publishedSnapshot(d1Mid, release.gateById(g1.id))
assert(pubMid.body.includes('旧正文'), '待审批期间对外仍为 v1 旧正文')

// ---------- 4. 管理员驳回 ----------
console.log('\n[4] 管理员驳回：版本不发布，文档保持已发布版')
const d3 = await mkDoc()
await saveVersion(d3.id, { body: '<p>d3 新内容 鉴权链路更新</p>' }, owner)
await mkCitation(d3.id, '鉴权如何设计?', 1)
r = await release.submitGate({ docId: d3.id }, owner)
const g3 = r.gate
for (const it of g3.impacts) await release.confirmImpact(g3.id, it.key, owner)
await release.confirmGate(g3.id, '', owner)
r = await release.decideGate(g3.id, 'reject', '内容需补充', editor)
assert(r.status === 'denied', '非管理员不能审批门禁')
r = await release.decideGate(g3.id, 'reject', '内容需补充', admin)
assert(r.status === 'ok' && r.gate.status === GATE.REJECTED, '管理员驳回门禁')
const d3After = await getDoc(d3.id)
assert(!isDocGated(d3After), '驳回后文档解除门禁态')
assert(d3After.body.includes('旧正文') && !d3After.body.includes('鉴权链路更新'), '驳回后正文恢复/保持已发布旧版，候选内容作废')
const v3Badge = d3After.versions.find((v) => v.version === 2)?.gate?.status
assert(v3Badge === GATE.REJECTED, '候选版本记录回写「门禁驳回」标记')
const g3After = release.gateById(g3.id)
assert(g3After.impacts.every((it) => it.status === 'pending'), '驳回后影响项状态还原为待确认')

// ---------- 5. 编辑者撤回 ----------
console.log('\n[5] 编辑者撤回门禁')
const d4 = await mkDoc()
await saveVersion(d4.id, { body: '<p>d4 新内容</p>' }, owner)
r = await release.submitGate({ docId: d4.id }, owner)
const g4 = r.gate
r = await release.withdrawGate(g4.id, editor)
assert(r.status === 'denied', '非发起人不能撤回他人门禁')
r = await release.withdrawGate(g4.id, owner)
assert(r.status === 'ok' && r.gate.status === GATE.WITHDRAWN, '发起人可撤回门禁')
const d4After = await getDoc(d4.id)
assert(!isDocGated(d4After) && d4After.body.includes('旧正文'), '撤回后解除门禁且正文保持已发布版')
// 撤回后可重新提交
await saveVersion(d4.id, { body: '<p>d4 更新后再次送门禁 新内容</p>' }, owner)
r = await release.submitGate({ docId: d4.id }, owner)
assert(r.status === 'ok', '撤回后可再次提交门禁')
await release.withdrawGate(r.gate.id, owner)

// ---------- 6. 审批放行：版本发布 + 问答引用切新版 + 链接状态回写 ----------
console.log('\n[6] 管理员审批放行：回写版本发布、引用与链接状态')
r = await release.decideGate(g1.id, 'approve', '', editor)
assert(r.status === 'denied', '非管理员不能放行门禁')
r = await release.decideGate(g1.id, 'approve', '同意发布', admin)
assert(r.status === 'ok' && r.gate.status === GATE.RELEASED, '管理员审批放行成功')
const d1Rel = await getDoc(d1.id)
assert(d1Rel.body.includes('新增鉴权说明') && !d1Rel.body.includes('旧正文'), '放行后候选 v2 内容回写文档对外可见')
assert(!isDocGated(d1Rel) && d1Rel.release.state === RELEASE_STATE.NORMAL && d1Rel.release.publishedVersion === 2, '文档解除门禁态，已发布版本指向 v2')
const v2 = d1Rel.versions.find((v) => v.version === 2)
assert(v2.gate?.status === GATE.RELEASED, '版本记录回写「门禁放行」标记')
// 问答引用切换到新版
const cit1After = await db.qaCitations.get(cit1.id)
assert(cit1After.docVersion === 2 && cit1After.gateId === g1.id, '关联问答引用回写为新版本 v2')
// 共享链接状态回写（保持有效，标记已同步到新版本）
const share1After = await db.shares.get(share1.id)
assert(isShareActive(share1After) && share1After.gateId === g1.id && share1After.gateVersion === 2, '共享链接保持有效并回写已同步的新版本')
// 缺口工单 timeline 留痕（状态/来源不变）
const ticket1After = await db.gapTickets.get(ticket1.id)
assert(ticket1After.status === GAP.RESOLVED && ticket1After.docId === d1.id, '缺口工单状态与答案来源不变')
assert(ticket1After.timeline.some((t) => t.action === 'version-publish'), '缺口工单留有「版本发布」痕迹')
// 门禁影响项回写为已生效
const g1Rel = release.gateById(g1.id)
assert(g1Rel.impacts.every((it) => it.status === 'released'), '全部影响项回写为已随版本发布')
assert(g1Rel.effects.releasedCitationIds.includes(cit1.id), '门禁结果记录已切换的引用')
assert(g1Rel.effects.syncedShareIds.includes(share1.id), '门禁结果记录已同步的链接')

// ---------- 7. 回退已放行版本 ----------
console.log('\n[7] 管理员回退：正文/引用/链接状态还原')
r = await release.rollbackGate(g1.id, '', owner)
assert(r.status === 'denied', '非管理员不能回退版本')
r = await release.rollbackGate(g1.id, '发现严重问题', admin)
assert(r.status === 'ok' && r.gate.status === GATE.ROLLED_BACK, '管理员回退成功')
const d1Rb = await getDoc(d1.id)
assert(d1Rb.body.includes('旧正文') && !d1Rb.body.includes('新增鉴权说明'), '回退后正文恢复到 v1')
assert(d1Rb.release.publishedVersion === 1, '已发布版本恢复指向 v1')
const v2Rb = d1Rb.versions.find((v) => v.version === 2)
assert(v2Rb.gate?.status === GATE.ROLLED_BACK, '被回退版本记录回写「已回退」标记')
const cit1Rb = await db.qaCitations.get(cit1.id)
assert(cit1Rb.docVersion === 1, '问答引用恢复到旧版本 v1')
const share1Rb = await db.shares.get(share1.id)
assert(isShareActive(share1Rb) && !share1Rb.gateId, '共享链接仍有效且发布同步标记已清除（内容随文档恢复旧版）')
const g1Rb = release.gateById(g1.id)
assert(g1Rb.impacts.every((it) => it.status === 'reverted'), '影响项回写为已随回退还原')

// ---------- 8. store 查询与角标 ----------
console.log('\n[8] store 查询与角标')
assert(release.openGateOfDoc(d1.id) === null, '已结案门禁不再被视为在途门禁')
// 构造一个待确认门禁供角标统计
const d5 = await mkDoc({ ownerId: owner.id, editors: [owner.id, editor.id] })
await saveVersion(d5.id, { body: '<p>d5 新内容 待确认</p>' }, editor)
r = await release.submitGate({ docId: d5.id }, editor)
assert(r.status === 'ok', '协作编辑者可对协作文档提交门禁')
assert(release.pendingConfirmFor(owner.id, 'editor').length >= 1, '负责人视角有待确认门禁')
assert(release.pendingConfirmFor(editor.id, 'editor').length === 0, '非负责人看不到他人待确认门禁')
assert(release.pendingApprovalFor('admin').length === 0, '当前无待审批门禁')
assert(release.pendingCountFor(owner.id, 'editor') >= 1, '负责人侧栏角标计数正确')

// ---------- 9. 删除带在途门禁的文档 ----------
console.log('\n[9] 删除文档联动关闭门禁与清理引用')
const del = await kb.deleteDoc(d5.id, admin)
assert(del.status === 'ok', '管理员删除带在途门禁的文档成功')
const g5 = release.gatesOfDoc(d5.id)[0]
assert(g5 && g5.status === GATE.WITHDRAWN && g5.timeline.some((t) => t.action === 'doc-delete'), '在途门禁随文档删除关闭并留痕')
const citCount = await db.qaCitations.where('docId').equals(d5.id).count()
assert(citCount === 0, '问答引用记录随文档清理')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
