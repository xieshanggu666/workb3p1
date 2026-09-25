import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { ensureVersions, docSnapshot } from '@/utils/version'
import {
  GATE, RELEASE_STATE, IMPACT, IMPACT_TYPE,
  isGateOpen, isGatePendingConfirm, isGatePendingApproval, isGateReleased,
  canSubmitGate, canConfirmGate, canWithdrawGate, canDecideGate, canRollbackGate,
  normalizeImpacts, markImpactConfirmed, allImpactsConfirmed,
  markImpactsReleased, markImpactsReset, impactCounts,
  CHECK, CHECK_TYPE, CHECK_ROLE,
  evaluateChecks, mergeChecks, ownerChecksCleared, allChecksCleared, blockedReasonsOf, canWaiveCheck,
  buildGateEntry
} from '@/utils/release'
import { canEditDoc, GUEST_ID, ROLE } from '@/utils/permission'
import { isGrantActive, ACCESS_PERM } from '@/utils/access'
import { shareStatus } from '@/utils/share'
import { isItemOpen } from '@/utils/handover'
import { isFreshTicketOpen } from '@/utils/freshness'
import { GAP } from '@/utils/gap'
import { RETIRE, isDocRetired } from '@/utils/retirement'
import { useKbStore } from './kb'

// 知识变更影响评估与发布门禁 store（统一状态机）：
// 编辑者保存新版本后「提交发布门禁」（submitGate）：
//   同事务锁定候选版本、把文档对外内容回退到门禁前已发布快照、自动关联受影响的
//   问答引用（qaCitations 命中记录）、已解决缺口工单（gapTickets 答案来源为本文档）与共享链接（shares），
//   并统一评估发布检查（评审结论 / 知识保鲜 / 未解决缺口 / 退役关系）生成阻断检查项；
// 负责人（拥有者）逐项确认影响、豁免负责人级检查项并整体确认（confirmImpact / waiveCheck / confirmGate）→ pending_approval；
// 管理员豁免管理员级检查项后审批放行（decideGate approve）：候选快照回写文档、追加发布版本标记、问答引用切换到新版、
//   共享链接状态同步、已豁免检查项联动回写关联实体（缺口工单/保鲜复核单/退役单）；
//   驳回（reject）/编辑者撤回（withdrawGate）：版本不发布，文档保持已发布版；
// 已放行版本管理员可回退（rollbackGate）：正文与问答引用恢复到发布前版本、链接状态还原。
// 流转被阻断时阻断原因回写门禁单（blockedReasons + timeline 留痕）；
// 外部条件解除后重新评估（recheckGate / 流转时自动重估）检查项自动恢复为「已解除」；
// 驳回/撤回后重新提交的门禁重新评估检查（豁免结论不跨门禁携带）。
// 全程在门禁单 timeline、版本记录门禁标记与各影响实体上留痕。
export const useReleaseStore = defineStore('release', () => {
  const gates = ref([])
  const loaded = ref(false)

  async function loadAll() {
    if (loaded.value) return
    await reload()
    loaded.value = true
  }

  async function reload() {
    gates.value = await db.releaseGates.toArray()
  }

  const sorted = computed(() =>
    [...gates.value].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  )

  // 某文档当前在途门禁（同一文档同时只允许一个）
  const openByDoc = computed(() => {
    const m = {}
    for (const g of gates.value) {
      if (isGateOpen(g)) m[g.docId] = g
    }
    return m
  })
  function openGateOfDoc(docId) {
    return openByDoc.value[docId] || null
  }

  function gateById(id) {
    return gates.value.find((g) => g.id === id) || null
  }

  function gatesOfDoc(docId) {
    return gates.value
      .filter((g) => g.docId === docId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  }

  // 待我确认影响（文档拥有者视角；管理员也可确认）
  function pendingConfirmFor(userId, role) {
    return sorted.value.filter((g) => {
      if (g.status !== GATE.PENDING_CONFIRM) return false
      return role === ROLE.ADMIN || g.ownerId === userId
    })
  }

  // 待我审批放行（管理员视角）
  function pendingApprovalFor(role) {
    if (role !== ROLE.ADMIN) return []
    return sorted.value.filter((g) => g.status === GATE.PENDING_APPROVAL)
  }

  function submittedBy(userId) {
    return sorted.value.filter((g) => g.submittedBy === userId)
  }

  // 侧栏角标：负责人待确认数 + （管理员）待审批数
  function pendingCountFor(userId, role) {
    return pendingConfirmFor(userId, role).length + (role === ROLE.ADMIN ? pendingApprovalFor(role).length : 0)
  }

  // 问答产生引用时记录（QAAssistant 提问后调用）：每条命中一条，便于门禁关联受影响引用。
  // question/snippet 为冗余快照；docVersion 为提问时该文档对外版本（门禁中即旧发布版）。
  async function recordCitations({ question, keywords, cites, askedBy }) {
    if (!cites || !cites.length) return
    const now = new Date().toISOString()
    const rows = cites.slice(0, 10).map((c, i) => ({
      id: uid('cit'),
      docId: c.id,
      question: String(question || '').slice(0, 200),
      keywords: [...(keywords || [])].slice(0, 20),
      snippet: String(c.snippet || '').slice(0, 500),
      docVersion: c.citeVersion ?? null,
      askedBy: askedBy || GUEST_ID,
      score: c.score ?? 0,
      gateId: null,
      createdAt: now,
      ordinal: i
    }))
    if (rows.length) await db.qaCitations.bulkAdd(rows)
  }

  // 事务内收集门禁影响项（问答引用 / 缺口工单 / 共享链接）
  async function collectImpactsTx(docId, doc) {
    // ① 问答引用：本文档最近被引用的记录（去重到问题级：同一问题只保留最新一条）
    const citeRows = await db.qaCitations.where('docId').equals(docId).toArray()
    citeRows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    const seenQ = new Set()
    const citations = []
    for (const c of citeRows) {
      const qkey = String(c.question || '').trim()
      if (!qkey || seenQ.has(qkey)) continue
      seenQ.add(qkey)
      citations.push({
        type: IMPACT_TYPE.CITATION,
        refId: c.id,
        title: qkey,
        subtitle: '引用版本 v' + (c.docVersion ?? '?') + ' · ' + new Date(c.createdAt).toLocaleDateString('zh-CN'),
        before: { docVersion: c.docVersion ?? null }
      })
      if (citations.length >= 20) break
    }

    // ② 缺口工单：答案来源已回填本文档（resolved）的工单随版本切换受影响；
    //    未解决（处理中/送审中）工单已升级为「发布检查项」（见 collectGateChecksTx），不再重复列入影响项
    const ticketRows = await db.gapTickets.where('docId').equals(docId).toArray()
    const tickets = ticketRows.filter((t) => t.status === GAP.RESOLVED).map((t) => ({
      type: IMPACT_TYPE.TICKET,
      refId: t.id,
      title: t.question,
      subtitle: '已解决 · 答案来源为本文档',
      before: { status: t.status }
    }))

    // ③ 共享链接：当前仍有效（未撤销/未过期）的链接随门禁纳入评估；记录撤销前状态供回退还原
    const shareRows = await db.shares.where('docId').equals(docId).toArray()
    const now = new Date()
    const shares = shareRows
      .filter((s) => shareStatus(s, now) === 'active')
      .map((s) => ({
        type: IMPACT_TYPE.SHARE,
        refId: s.id,
        title: s.permission === 'edit' ? '可编辑共享链接' : '只读共享链接',
        subtitle: (s.expiresAt ? '限期链接' : '永久链接'),
        before: { revokedAt: s.revokedAt || null, revokeReason: s.revokeReason || null }
      }))

    return normalizeImpacts([...citations, ...tickets, ...shares])
  }

  // 事务内统一评估发布检查（评审结论 / 知识保鲜 / 未解决缺口 / 退役关系）：
  // 四个维度的阻断条件各生成一条检查项，随门禁流转重新评估（confirmGate / decideGate / recheckGate），
  // 条件解除自动恢复为「已解除」，存续条件可经对应角色豁免（跨角色审批）
  async function collectGateChecksTx(doc, now) {
    if (!doc) return []
    // ① 评审结论：流转中的评审单（不可豁免，须先完结）；最近一次评审结论为驳回（负责人确认后可继续）
    const pendingReview = await db.reviews
      .where('docId').equals(doc.id)
      .filter((rv) => rv.status === 'pending').first()
    // ② 知识保鲜：流转中复核单（待整改/送审中/已驳回）或复核周期已到点
    const openFresh = await db.freshnessTickets
      .where('docId').equals(doc.id)
      .filter((t) => isFreshTicketOpen(t)).first()
    // ③ 未解决缺口：关联本文档且未解决的工单（已解决工单列入影响项）
    const unresolvedGaps = (await db.gapTickets.where('docId').equals(doc.id).toArray())
      .filter((t) => t.status !== GAP.RESOLVED)
    // ④ 退役关系：本文档正作为他人在途/生效退役的替代文档（替代链上的版本变更需管理员确认）
    const replacementOf = await db.retirements
      .filter((r) => (r.status === RETIRE.PENDING || r.status === RETIRE.APPROVED) && r.replacementDocId === doc.id)
      .toArray()
    return evaluateChecks({ doc, pendingReview, openFreshTicket: openFresh, unresolvedGaps, replacementOf }, now)
  }

  // 提交发布门禁。
  // payload: { docId, note, citationIds?（额外勾选的引用，默认自动收集）, ticketIds?, shareIds? }
  // 返回 { status:'ok', gate } | 'guest' | 'denied' | 'missing' | 'no-change' | 'duplicate' | 'in-review'
  async function submitGate(payload, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }

    await db.transaction(
      'rw',
      db.docs, db.releaseGates, db.reviews, db.accessRequests, db.shares, db.gapTickets, db.qaCitations, db.handovers, db.freshnessTickets, db.retirements,
      async () => {
        const doc = await db.docs.get(payload.docId)
        if (!doc) { result = { status: 'missing' }; return }
        // 退役关系硬阻断：已退役文档为只读归档；退役审批中的文档先走完退役流程再发起门禁
        if (isDocRetired(doc)) { result = { status: 'retired' }; return }
        const openRetirement = await db.retirements
          .where('docId').equals(doc.id)
          .filter((r) => r.status === RETIRE.PENDING).first()
        if (openRetirement) { result = { status: 'in-retirement' }; return }
        const versions = ensureVersions(doc, now)
        const candidateVersion = versions.length
        const openReview = await db.reviews
          .where('docId').equals(doc.id)
          .filter((rv) => rv.status === 'pending').first()
        // 责任交接流转中：批准交接会按快照校验并发变更，门禁先完成/撤回再发起
        const openHandover = await db.handovers
          .filter((h) => (h.items || []).some((i) => i.docId === doc.id && isItemOpen(i))).first()
        const dupGate = await db.releaseGates
          .where('docId').equals(doc.id)
          .filter((g) => isGateOpen(g)).first()

        // 事务内复核写入资格（与 canEditDoc 同源：拥有者/协作者/管理员/限时协作授权）
        let grant = null
        if (userId !== GUEST_ID) {
          const reqs = await db.accessRequests
            .where('docId').equals(doc.id)
            .filter((r) => r.applicantId === userId).toArray()
          grant = reqs.find((r) => isGrantActive(r) && r.grant?.permission === ACCESS_PERM.COLLAB) || null
        }
        const canEdit = canEditDoc(doc, { userId, role, grant, pendingReview: openReview })
        if (!canSubmitGate(doc, { userId, role, canEditDoc: canEdit, pendingReview: openReview, openGate: dupGate })) {
          if (userId === GUEST_ID) { result = { status: 'guest' }; return }
          if (openReview) { result = { status: 'in-review' }; return }
          if (openHandover) { result = { status: 'in-handover' }; return }
          if (dupGate) { result = { status: 'duplicate', gate: dupGate }; return }
          result = { status: 'denied' }
          return
        }
        if (candidateVersion <= 1) { result = { status: 'no-change' }; return }

        // 已发布基线：门禁机制下取 doc.release.publishedSnapshot（连续门禁场景），
        // 否则取候选版本的上一个版本快照——编辑者直接保存后文档当前字段即候选内容，
        // 真正对外的「已发布版」是上一个版本的内容快照
        const prevVersion = versions[candidateVersion - 2]
        const published = doc.release?.publishedSnapshot
          ? { ...doc.release.publishedSnapshot, tagIds: [...(doc.release.publishedSnapshot.tagIds || [])] }
          : (prevVersion?.snapshot ? { ...prevVersion.snapshot, tagIds: [...(prevVersion.snapshot.tagIds || [])] } : docSnapshot(doc))
        const candidateSnap = versions[candidateVersion - 1].snapshot
        if (!candidateSnap || JSON.stringify(sortSnap(candidateSnap)) === JSON.stringify(sortSnap(published))) {
          result = { status: 'no-change' }
          return
        }

        // 自动收集影响项（问答引用 / 缺口工单 / 共享链接）
        const auto = await collectImpactsTx(doc.id, doc)
        // 调用方显式勾选/取消时按类型 refId 过滤；未传则全部采用自动结果
        let impacts = auto
        const picks = {
          [IMPACT_TYPE.CITATION]: payload.citationIds,
          [IMPACT_TYPE.TICKET]: payload.ticketIds,
          [IMPACT_TYPE.SHARE]: payload.shareIds
        }
        const hasPicks = Object.values(picks).some((arr) => Array.isArray(arr))
        if (hasPicks) {
          impacts = auto.filter((it) => {
            const arr = picks[it.type]
            return Array.isArray(arr) ? arr.includes(it.refId) : true
          })
        }

        const publishedVersion = doc.release?.publishedVersion ?? (candidateVersion - 1)
        // 统一评估发布检查（评审结论/知识保鲜/未解决缺口/退役关系），阻断项随门禁流转处理
        const checks = await collectGateChecksTx(doc, now)
        const gate = {
          id: uid('gate'),
          docId: doc.id,
          docTitle: doc.title,
          status: GATE.PENDING_CONFIRM,
          version: candidateVersion,
          publishedVersion,
          submittedBy: userId,
          ownerId: doc.ownerId,
          note: String(payload.note || '').trim(),
          impacts,
          checks,
          blockedReasons: null,
          blockedAt: null,
          blockedStage: null,
          candidateSnapshot: { ...candidateSnap, tagIds: [...(candidateSnap.tagIds || [])] },
          publishedSnapshot: published,
          confirmedBy: null,
          confirmedAt: null,
          decidedBy: null,
          decidedAt: null,
          decisionNote: '',
          rolledBackBy: null,
          rolledBackAt: null,
          rollbackNote: '',
          releasedAt: null,
          createdAt: now,
          timeline: [buildGateEntry('submit', userId, payload.note || ('v' + candidateVersion + ' 提交发布门禁，待负责人确认影响'), now)]
        }
        await db.releaseGates.add(gate)

        // 文档进入门禁中：对外内容锁定为已发布快照，候选版本不提前泄露；
        // 当前字段先不改动（候选内容已经在 doc 上），通过 doc.release 标记让展示/问答/搜索统一回退显示已发布版
        const releaseInfo = {
          state: RELEASE_STATE.GATED,
          activeGateId: gate.id,
          publishedVersion,
          publishedSnapshot: published,
          updatedAt: now
        }
        await db.docs.update(doc.id, { release: releaseInfo })

        // 候选版本记录打上门禁标记（版本历史中可见「待影响确认」）
        const newVersions = versions.map((v) =>
          v.version === candidateVersion
            ? { ...v, gate: { gateId: gate.id, version: candidateVersion, status: GATE.PENDING_CONFIRM, at: now } }
            : v
        )
        await db.docs.update(doc.id, { versions: newVersions })

        result = { status: 'ok', gate }
      }
    )

    await Promise.all([reload(), kb.reloadDocs()])
    return result
  }

  // 负责人逐项确认影响
  async function confirmImpact(gateId, impactKey, currentUser) {
    const kb = useKbStore()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }

    await db.transaction('rw', db.releaseGates, db.docs, async () => {
      const gate = await db.releaseGates.get(gateId)
      if (!gate) { result = { status: 'missing' }; return }
      const doc = await db.docs.get(gate.docId)
      if (!canConfirmGate(gate, doc, userId, role)) { result = { status: 'denied' }; return }
      const item = (gate.impacts || []).find((it) => it.key === impactKey)
      if (!item) { result = { status: 'no-impact' }; return }
      if (item.status !== IMPACT.PENDING) { result = { status: 'changed' }; return }
      const impacts = markImpactConfirmed(gate.impacts, impactKey, userId, now)
      await db.releaseGates.put({
        ...gate,
        impacts,
        timeline: [...(gate.timeline || []), buildGateEntry('impact-confirm-item', userId, '确认影响：' + item.title, now)]
      })
      result = { status: 'ok' }
    })

    await reload()
    return result
  }

  // 负责人整体确认影响 → 待管理员审批（要求全部影响项已逐项确认；无影响项可直接确认）。
  // 统一状态机：整体确认前重新评估发布检查（评审结论/知识保鲜/未解决缺口/退役关系）——
  // 负责人级与不可豁免检查仍阻断时不予提交审批，阻断原因回写门禁单（管理员级检查留待审批环节）。
  async function confirmGate(gateId, note, currentUser) {
    const kb = useKbStore()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }

    await db.transaction('rw', db.releaseGates, db.docs, db.reviews, db.freshnessTickets, db.gapTickets, db.retirements, async () => {
      const gate = await db.releaseGates.get(gateId)
      if (!gate) { result = { status: 'missing' }; return }
      const doc = await db.docs.get(gate.docId)
      if (!canConfirmGate(gate, doc, userId, role)) { result = { status: 'denied' }; return }
      if (!allImpactsConfirmed(gate.impacts)) { result = { status: 'unconfirmed' }; return }
      const checks = doc ? mergeChecks(gate.checks, await collectGateChecksTx(doc, now), now) : (gate.checks || [])
      if (!ownerChecksCleared(checks)) {
        const reasons = blockedReasonsOf(checks, now).filter((r) => r.approverRole !== CHECK_ROLE.ADMIN)
        await db.releaseGates.put({
          ...gate,
          checks,
          blockedReasons: reasons,
          blockedAt: now,
          blockedStage: 'confirm',
          timeline: [...(gate.timeline || []), buildGateEntry('gate-blocked', userId, '整体确认被阻断：' + reasons.map((r) => r.title).join('；'), now)]
        })
        result = { status: 'blocked', reasons }
        return
      }
      const resumed = (gate.blockedReasons || []).length
        ? [buildGateEntry('gate-resumed', userId, '阻断条件已解除，恢复流转', now)]
        : []
      const confirmed = {
        ...gate,
        status: GATE.PENDING_APPROVAL,
        checks,
        blockedReasons: null,
        blockedAt: null,
        blockedStage: null,
        confirmedBy: userId,
        confirmedAt: now,
        timeline: [...(gate.timeline || []), ...resumed, buildGateEntry('impact-confirm-all', userId, note || '负责人已确认全部影响，提交管理员审批', now)]
      }
      await db.releaseGates.put(confirmed)
      // 版本门禁标记推进到待审批
      if (doc) {
        const versions = (doc.versions || []).map((v) =>
          v.gate?.gateId === gateId ? { ...v, gate: { ...v.gate, status: GATE.PENDING_APPROVAL, at: now } } : v
        )
        await db.docs.update(doc.id, { versions })
      }
      result = { status: 'ok', gate: confirmed }
    })

    await Promise.all([reload(), kb.reloadDocs()])
    return result
  }

  // 豁免发布检查项（跨角色审批）：负责人级检查由文档拥有者/管理员豁免，管理员级检查仅管理员可豁免；
  // 不可豁免检查（approverRole 为 null，如在途评审）须先解除条件。豁免结论与说明写入门禁单留痕，
  // 并同步重算当前阻断原因回写（仍存续的阻断项保持可见）。
  // 返回 { status: 'ok' } | 'missing' | 'no-check' | 'changed' | 'denied' | 'guest'
  async function waiveCheck(gateId, checkKey, note, currentUser) {
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }

    await db.transaction('rw', db.releaseGates, db.docs, async () => {
      const gate = await db.releaseGates.get(gateId)
      if (!gate) { result = { status: 'missing' }; return }
      const doc = await db.docs.get(gate.docId)
      const check = (gate.checks || []).find((c) => c.key === checkKey)
      if (!check) { result = { status: 'no-check' }; return }
      if (!canWaiveCheck(gate, check, doc, userId, role)) {
        result = userId === GUEST_ID ? { status: 'guest' } : check.state !== CHECK.BLOCKED ? { status: 'changed' } : { status: 'denied' }
        return
      }
      const checks = gate.checks.map((c) => c.key === checkKey
        ? { ...c, state: CHECK.WAIVED, waivedBy: userId, waivedAt: now, waiveNote: String(note || '').trim() }
        : c)
      const remaining = blockedReasonsOf(checks, now)
      await db.releaseGates.put({
        ...gate,
        checks,
        blockedReasons: remaining.length ? remaining : null,
        timeline: [...(gate.timeline || []), buildGateEntry('check-waive', userId, '豁免「' + check.title + '」' + (note ? '：' + note : ''), now)]
      })
      result = { status: 'ok' }
    })

    await reload()
    return result
  }

  // 重新评估发布检查（状态恢复）：外部条件变化后（工单解决/复核通过/评审完结/退役处理等）
  // 重新评估四维检查——已解除的条件恢复为「已解除」并留痕，新出现的条件生成阻断项，
  // 仍存续的豁免结论保持有效；阻断原因回写同步刷新，全部解除时记录「恢复流转」。
  // 返回 { status: 'ok', recovered, emerged, reasons } | 'missing' | 'closed' | 'denied' | 'guest'
  async function recheckGate(gateId, currentUser) {
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }

    await db.transaction('rw', db.releaseGates, db.docs, db.reviews, db.freshnessTickets, db.gapTickets, db.retirements, async () => {
      const gate = await db.releaseGates.get(gateId)
      if (!gate) { result = { status: 'missing' }; return }
      if (!isGateOpen(gate)) { result = { status: 'closed' }; return }
      if (userId === GUEST_ID) { result = { status: 'guest' }; return }
      const doc = await db.docs.get(gate.docId)
      if (!doc) { result = { status: 'doc-missing' }; return }
      const involved = role === ROLE.ADMIN || doc.ownerId === userId || gate.submittedBy === userId
      if (!involved) { result = { status: 'denied' }; return }

      const prevBlocked = new Set((gate.checks || []).filter((c) => c.state === CHECK.BLOCKED).map((c) => c.key))
      const checks = mergeChecks(gate.checks, await collectGateChecksTx(doc, now), now)
      const nextBlocked = new Set(checks.filter((c) => c.state === CHECK.BLOCKED).map((c) => c.key))
      const recovered = [...prevBlocked].filter((k) => !nextBlocked.has(k))
      const emerged = [...nextBlocked].filter((k) => !prevBlocked.has(k))
      const reasons = blockedReasonsOf(checks, now)

      const timeline = [...(gate.timeline || [])]
      if (recovered.length || emerged.length) {
        timeline.push(buildGateEntry('gate-recheck', userId,
          (recovered.length ? '解除 ' + recovered.length + ' 项' : '') +
          (recovered.length && emerged.length ? '，' : '') +
          (emerged.length ? '新增阻断 ' + emerged.length + ' 项' : ''), now))
      }
      if ((gate.blockedReasons || []).length && !reasons.length) {
        timeline.push(buildGateEntry('gate-resumed', userId, '阻断条件已解除，恢复流转', now))
      }
      await db.releaseGates.put({ ...gate, checks, blockedReasons: reasons.length ? reasons : null, timeline })
      result = { status: 'ok', recovered, emerged, reasons }
    })

    await reload()
    return result
  }

  // 编辑者撤回门禁（确认前 / 待审批均可）
  async function withdrawGate(gateId, currentUser) {
    const kb = useKbStore()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }

    await db.transaction('rw', db.releaseGates, db.docs, async () => {
      const gate = await db.releaseGates.get(gateId)
      if (!gate) { result = { status: 'missing' }; return }
      if (!canWithdrawGate(gate, userId, role)) { result = { status: 'denied' }; return }
      const withdrawn = {
        ...gate,
        status: GATE.WITHDRAWN,
        impacts: markImpactsReset(gate.impacts, false),
        timeline: [...(gate.timeline || []), buildGateEntry('withdraw', userId, '', now)]
      }
      await db.releaseGates.put(withdrawn)
      await clearDocGateTx(gate, now)
      result = { status: 'ok', gate: withdrawn }
    })

    await Promise.all([reload(), kb.reloadDocs()])
    return result
  }

  // 管理员审批：approve 放行发布 / reject 驳回
  async function decideGate(gateId, decision, note, currentUser) {
    const kb = useKbStore()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    let result = { status: 'error' }

    await db.transaction(
      'rw',
      db.releaseGates, db.docs, db.shares, db.gapTickets, db.qaCitations, db.reviews, db.freshnessTickets, db.retirements,
      async () => {
        const gate = await db.releaseGates.get(gateId)
        if (!gate) { result = { status: 'missing' }; return }
        if (!canDecideGate(gate, userId, currentUser?.role)) {
          result = userId === GUEST_ID ? { status: 'guest' } : { status: 'denied' }
          return
        }
        const doc = await db.docs.get(gate.docId)
        if (!doc) { result = { status: 'doc-missing' }; return }

        if (decision === 'reject') {
          const rejected = {
            ...gate,
            status: GATE.REJECTED,
            decidedBy: userId,
            decidedAt: now,
            decisionNote: String(note || '').trim(),
            impacts: markImpactsReset(gate.impacts, false),
            timeline: [...(gate.timeline || []), buildGateEntry('reject', userId, note, now)]
          }
          await db.releaseGates.put(rejected)
          await clearDocGateTx(gate, now, GATE.REJECTED)
          result = { status: 'ok', gate: rejected, approved: false }
          return
        }

        // ---- 统一状态机：放行前重新评估发布检查，任一检查仍阻断即不予放行并回写阻断原因 ----
        const checks = mergeChecks(gate.checks, await collectGateChecksTx(doc, now), now)
        if (!allChecksCleared(checks)) {
          const reasons = blockedReasonsOf(checks, now)
          await db.releaseGates.put({
            ...gate,
            checks,
            blockedReasons: reasons,
            blockedAt: now,
            blockedStage: 'approve',
            timeline: [...(gate.timeline || []), buildGateEntry('gate-blocked', userId, '放行被阻断：' + reasons.map((r) => r.title).join('；'), now)]
          })
          result = { status: 'blocked', reasons }
          return
        }

        // ---- 放行发布：回写候选快照 → 文档对外可见；问答引用切新版；共享链接状态同步 ----
        const snap = gate.candidateSnapshot
        // ① 文档字段回写候选版本，解除门禁；已发布快照即候选内容
        const releaseInfo = {
          state: RELEASE_STATE.NORMAL,
          activeGateId: null,
          publishedVersion: gate.version,
          publishedSnapshot: { ...snap, tagIds: [...(snap.tagIds || [])] },
          updatedAt: now
        }
        // ② 问答引用：门禁发起时关联的引用记录 docVersion 切换到新版本，打上放行标记
        const releasedCitationIds = []
        for (const it of gate.impacts || []) {
          if (it.type !== IMPACT_TYPE.CITATION) continue
          const c = await db.qaCitations.get(it.refId)
          if (!c) continue
          await db.qaCitations.update(c.id, {
            docVersion: gate.version,
            gateId: gate.id,
            gateReleasedAt: now
          })
          releasedCitationIds.push(c.id)
        }
        // 门禁期间新产生的引用（指向旧发布版）也一并切到新版，保证放行后问答一致
        const otherCites = await db.qaCitations
          .where('docId').equals(doc.id)
          .filter((c) => (c.docVersion ?? 0) < gate.version).toArray()
        for (const c of otherCites) {
          if (releasedCitationIds.includes(c.id)) continue
          await db.qaCitations.update(c.id, { docVersion: gate.version, gateId: gate.id, gateReleasedAt: now })
          releasedCitationIds.push(c.id)
        }

        // ③ 缺口工单：门禁放行不改工单状态，仅记录其答案来源已随新版发布（timeline 留痕）
        const releasedTicketIds = []
        for (const it of gate.impacts || []) {
          if (it.type !== IMPACT_TYPE.TICKET) continue
          const t = await db.gapTickets.get(it.refId)
          if (!t) continue
          await db.gapTickets.update(t.id, {
            timeline: [...(t.timeline || []), buildGateEntry('version-publish', userId, '关联文档《' + gate.docTitle + '》v' + gate.version + ' 经发布门禁放行，答案来源已指向新版', now)]
          })
          releasedTicketIds.push(t.id)
        }

        // ④ 共享链接：门禁期间链接对访客呈现已发布旧版；放行后链接自然指向新版（链接本身保持有效），
        //    逐条标记已同步发布版本，便于门禁单回写链接状态并留痕
        const syncedShareIds = []
        for (const it of gate.impacts || []) {
          if (it.type !== IMPACT_TYPE.SHARE) continue
          const s = await db.shares.get(it.refId)
          if (!s) continue
          await db.shares.update(s.id, { gateId: gate.id, gateVersion: gate.version, gateSyncedAt: now })
          syncedShareIds.push(s.id)
        }

        // ⑤ 已豁免检查项联动回写：阻断已经跨角色确认豁免的事实写回关联实体（缺口工单/保鲜复核单/退役单）
        const waivedChecks = checks.filter((c) => c.state === CHECK.WAIVED)
        for (const c of waivedChecks) {
          if (c.type === CHECK_TYPE.GAP && c.refId) {
            const t = await db.gapTickets.get(c.refId)
            if (t) {
              await db.gapTickets.update(t.id, {
                timeline: [...(t.timeline || []), buildGateEntry('gate-release', userId, '关联文档《' + gate.docTitle + '》v' + gate.version + ' 经发布门禁放行（缺口未解决，已豁免）', now)]
              })
            }
          } else if (c.type === CHECK_TYPE.FRESHNESS && c.refId) {
            const t = await db.freshnessTickets.get(c.refId)
            if (t) {
              await db.freshnessTickets.update(t.id, {
                timeline: [...(t.timeline || []), buildGateEntry('gate-release', userId, '发布门禁放行 v' + gate.version + '（复核未结案，已豁免）', now)]
              })
            }
          } else if (c.type === CHECK_TYPE.RETIREMENT && c.refId) {
            const r = await db.retirements.get(c.refId)
            if (r) {
              await db.retirements.update(r.id, {
                timeline: [...(r.timeline || []), buildGateEntry('replacement-release', userId, '替代文档《' + gate.docTitle + '》v' + gate.version + ' 经发布门禁发布', now)]
              })
            }
          }
        }

        const updatedDoc = {
          ...doc,
          ...snap,
          visibility: snap.visibility,
          updatedAt: now,
          release: releaseInfo,
          lastReleaseGate: { gateId: gate.id, status: GATE.RELEASED, version: gate.version, by: userId, at: now }
        }
        // ⑥ 版本记录门禁标记 → 已放行
        updatedDoc.versions = ensureVersions(updatedDoc, now).map((v) =>
          v.version === gate.version
            ? { ...v, gate: { gateId: gate.id, version: gate.version, status: GATE.RELEASED, at: now, releasedBy: userId } }
            : v
        )
        await db.docs.put(updatedDoc)

        const counts = impactCounts(gate.impacts)
        const released = {
          ...gate,
          status: GATE.RELEASED,
          decidedBy: userId,
          decidedAt: now,
          decisionNote: String(note || '').trim(),
          releasedAt: now,
          checks,
          blockedReasons: null,
          blockedAt: null,
          blockedStage: null,
          impacts: markImpactsReleased(gate.impacts, (it) => {
            if (it.type === IMPACT_TYPE.CITATION) return { releasedAt: now, docVersion: gate.version }
            if (it.type === IMPACT_TYPE.SHARE) return { syncedAt: now }
            return { releasedAt: now }
          }),
          effects: { releasedCitationIds, releasedTicketIds, syncedShareIds },
          timeline: [
            ...(gate.timeline || []),
            buildGateEntry('approve', userId, note, now),
            buildGateEntry('version-publish', userId, 'v' + gate.version + ' 发布，问答引用 ' + releasedCitationIds.length + ' 条切换至新版', now),
            buildGateEntry('share-sync', userId, '共享链接 ' + syncedShareIds.length + ' 条状态已同步（' + counts.share + ' 条纳入评估）', now),
            ...(waivedChecks.length ? [buildGateEntry('checks-release', userId, waivedChecks.length + ' 项已豁免检查随放行生效', now)] : [])
          ]
        }
        await db.releaseGates.put(released)
        result = { status: 'ok', gate: released, approved: true }
      }
    )

    await Promise.all([reload(), kb.reloadDocs()])
    return result
  }

  // 回退已放行版本：正文/问答引用恢复到门禁前发布版，链接状态还原
  async function rollbackGate(gateId, note, currentUser) {
    const kb = useKbStore()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    let result = { status: 'error' }

    await db.transaction(
      'rw',
      db.releaseGates, db.docs, db.shares, db.gapTickets, db.qaCitations,
      async () => {
        const gate = await db.releaseGates.get(gateId)
        if (!gate) { result = { status: 'missing' }; return }
        if (!canRollbackGate(gate, userId, currentUser?.role)) {
          result = userId === GUEST_ID ? { status: 'guest' } : { status: 'denied' }
          return
        }
        const doc = await db.docs.get(gate.docId)
        if (!doc) { result = { status: 'doc-missing' }; return }

        const snap = gate.publishedSnapshot
        // ① 文档正文回退到门禁前发布版（保留版本历史，被回退版本打标）
        const restoredInfo = {
          state: RELEASE_STATE.NORMAL,
          activeGateId: null,
          publishedVersion: gate.publishedVersion,
          publishedSnapshot: { ...snap, tagIds: [...(snap.tagIds || [])] },
          updatedAt: now
        }
        // ② 问答引用恢复旧版本号（仅还原本门禁切换过、且当前仍指向新版本的记录）
        const restoredCitationIds = []
        for (const cid of gate.effects?.releasedCitationIds || []) {
          const c = await db.qaCitations.get(cid)
          if (!c || c.gateId !== gate.id || c.docVersion !== gate.version) continue
          await db.qaCitations.update(c.id, { docVersion: gate.publishedVersion, gateRolledBackAt: now })
          restoredCitationIds.push(c.id)
        }
        // ③ 缺口工单留痕（不改状态/来源）
        const restoredTicketIds = []
        for (const tid of gate.effects?.releasedTicketIds || []) {
          const t = await db.gapTickets.get(tid)
          if (!t) continue
          await db.gapTickets.update(t.id, {
            timeline: [...(t.timeline || []), buildGateEntry('version-revert', userId, '关联文档《' + gate.docTitle + '》v' + gate.version + ' 已被管理员回退，问答引用恢复 v' + gate.publishedVersion, now)]
          })
          restoredTicketIds.push(t.id)
        }
        // ④ 共享链接：清除本次发布同步标记（链接仍有效，访问内容随文档回退自动恢复旧版）
        const restoredShareIds = []
        for (const sid of gate.effects?.syncedShareIds || []) {
          const s = await db.shares.get(sid)
          if (!s || s.gateId !== gate.id) continue
          await db.shares.update(s.id, { gateId: null, gateVersion: null, gateSyncedAt: null, gateRolledBackAt: now })
          restoredShareIds.push(s.id)
        }

        const updatedDoc = {
          ...doc,
          ...snap,
          visibility: snap.visibility,
          updatedAt: now,
          release: restoredInfo,
          lastReleaseGate: { gateId: gate.id, status: GATE.ROLLED_BACK, version: gate.version, by: userId, at: now }
        }
        updatedDoc.versions = ensureVersions(updatedDoc, now).map((v) =>
          v.version === gate.version
            ? { ...v, gate: { ...(v.gate || {}), gateId: gate.id, version: gate.version, status: GATE.ROLLED_BACK, at: now, rolledBackBy: userId } }
            : v
        )
        await db.docs.put(updatedDoc)

        const rolledBack = {
          ...gate,
          status: GATE.ROLLED_BACK,
          rolledBackBy: userId,
          rolledBackAt: now,
          rollbackNote: String(note || '').trim(),
          impacts: markImpactsReset(gate.impacts, true),
          effects: { ...(gate.effects || {}), restoredCitationIds, restoredTicketIds, restoredShareIds },
          timeline: [
            ...(gate.timeline || []),
            buildGateEntry('rollback', userId, note, now),
            buildGateEntry('version-revert', userId, '问答引用 ' + restoredCitationIds.length + ' 条恢复至 v' + gate.publishedVersion, now),
            buildGateEntry('share-restore', userId, '共享链接 ' + restoredShareIds.length + ' 条状态已还原', now)
          ]
        }
        await db.releaseGates.put(rolledBack)
        result = { status: 'ok', gate: rolledBack, restoredCitationIds, restoredShareIds }
      }
    )

    await Promise.all([reload(), kb.reloadDocs()])
    return result
  }

  // 文档删除时清理其全部门禁（由 kb.deleteDoc 在同事务内调用）
  async function resetGatesOfDocTx(docId, now) {
    const list = await db.releaseGates.where('docId').equals(docId).toArray()
    for (const g of list) {
      if (isGateOpen(g)) {
        await db.releaseGates.update(g.id, {
          status: GATE.WITHDRAWN,
          timeline: [...(g.timeline || []), buildGateEntry('doc-delete', 'system', '关联文档已删除，门禁关闭', now)]
        })
      }
    }
  }

  return {
    gates, loaded, loadAll, reload, sorted,
    openGateOfDoc, gateById, gatesOfDoc,
    pendingConfirmFor, pendingApprovalFor, submittedBy, pendingCountFor,
    recordCitations, collectImpactsTx,
    submitGate, confirmImpact, confirmGate, waiveCheck, recheckGate, withdrawGate, decideGate, rollbackGate,
    resetGatesOfDocTx
  }
})

// ---- 事务内工具 ----

function sortSnap(s) {
  return {
    title: s?.title || '',
    body: s?.body || '',
    categoryId: s?.categoryId ?? null,
    tagIds: [...(s?.tagIds || [])].sort(),
    visibility: s?.visibility || 'public'
  }
}

// 门禁结束（驳回/撤回）时清除文档门禁标记：正文保持当前已发布版（门禁期间文档字段未回写候选，
// 这里需要把对外字段恢复为门禁前快照——候选编辑内容随驳回/撤回作废）。
// 调用方须已在写事务内。
async function clearDocGateTx(gate, now, endStatus) {
  const doc = await db.docs.get(gate.docId)
  if (!doc) return
  const versions = ensureVersions(doc, now)
  const newVersions = versions.map((v) => {
    if (v.version !== gate.version || v.gate?.gateId !== gate.id) return v
    const status = endStatus || GATE.WITHDRAWN
    const { gate: _g, ...rest } = v
    return { ...rest, gate: { gateId: gate.id, version: gate.version, status, at: now } }
  })
  // 驳回/撤回：候选内容作废，文档字段恢复到已发布快照（问答/搜索/共享访问无需再回退判断）
  const snap = gate.publishedSnapshot
  await db.docs.update(doc.id, {
    ...snap,
    visibility: snap.visibility,
    updatedAt: now,
    release: {
      state: RELEASE_STATE.NORMAL,
      activeGateId: null,
      publishedVersion: gate.publishedVersion,
      publishedSnapshot: { ...snap, tagIds: [...(snap.tagIds || [])] },
      updatedAt: now
    },
    versions: newVersions
  })
}
