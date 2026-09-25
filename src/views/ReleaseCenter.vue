<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useReleaseStore } from '@/stores/release'
import DocPill from '@/components/common/DocPill.vue'
import { formatDate, formatFull } from '@/utils/format'
import {
  GATE, gateStatusLabel, gateStatusCls, gateTimelineLabel,
  impactTypeLabel, impactStatusLabel, impactCounts, IMPACT,
  checkTypeLabel, checkStateLabel, checkApproverLabel, checkCounts, canWaiveCheck
} from '@/utils/release'
import { diffVersionFields, fieldLabels } from '@/utils/version'

const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const releaseStore = useReleaseStore()

const tab = ref('todo') // todo | mine | all
const confirmNoteMap = ref({})
const decideNoteMap = ref({})
const rollbackNoteMap = ref({})
const busyId = ref('')

const isAdmin = computed(() => auth.user?.role === 'admin')
const docById = computed(() => Object.fromEntries(kb.docs.map((d) => [d.id, d])))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
const userName = (id) => (id === 'system' ? '系统' : userById.value[id]?.name || id)

const todoList = computed(() =>
  releaseStore.sorted.filter((g) =>
    g.status === GATE.PENDING_APPROVAL
      ? isAdmin.value
      : g.status === GATE.PENDING_CONFIRM && (isAdmin.value || g.ownerId === auth.user?.id)
  )
)
const mineList = computed(() => releaseStore.sorted.filter((g) => g.submittedBy === auth.user?.id))
const allList = computed(() => isAdmin.value ? releaseStore.sorted : releaseStore.sorted.filter((g) => g.submittedBy === auth.user?.id || g.ownerId === auth.user?.id))

const list = computed(() => {
  if (tab.value === 'todo') return todoList.value
  if (tab.value === 'mine') return mineList.value
  return allList.value
})

const counts = computed(() => ({
  todo: todoList.value.length,
  mine: mineList.value.length,
  all: allList.value.length
}))

function changedFields(g) {
  if (!g.candidateSnapshot || !g.publishedSnapshot) return []
  return diffVersionFields(g.publishedSnapshot, g.candidateSnapshot)
}

async function confirmItem(g, key) {
  const res = await releaseStore.confirmImpact(g.id, key, auth.user)
  if (res.status === 'denied') alert('只有文档负责人或管理员可以确认影响。')
}

async function confirmAll(g) {
  if (g.impacts.some((it) => it.status === IMPACT.PENDING)) { alert('仍有影响项未逐项确认。'); return }
  const res = await releaseStore.confirmGate(g.id, (confirmNoteMap.value[g.id] || '').trim(), auth.user)
  if (res.status === 'ok') confirmNoteMap.value[g.id] = ''
  else if (res.status === 'denied') alert('只有文档负责人或管理员可以确认影响。')
  else if (res.status === 'blocked') alert('仍存在阻断中的发布检查项：\n' + (res.reasons || []).map((x) => '· ' + x.title).join('\n'))
}

async function withdraw(g) {
  if (!confirm('确定撤回该发布门禁？候选版本将不发布。')) return
  const res = await releaseStore.withdrawGate(g.id, auth.user)
  if (res.status !== 'ok') alert('操作失败：门禁状态已变化')
}

async function decide(g, decision) {
  if (busyId.value) return
  busyId.value = g.id
  try {
    const res = await releaseStore.decideGate(g.id, decision, (decideNoteMap.value[g.id] || '').trim(), auth.user)
    if (res.status === 'ok') decideNoteMap.value[g.id] = ''
    else if (res.status === 'denied' || res.status === 'guest') alert('只有管理员可以审批放行或驳回。')
    else if (res.status === 'blocked') alert('放行被阻断，仍存在未解除的发布检查项：\n' + (res.reasons || []).map((x) => '· ' + x.title).join('\n'))
    else alert('操作失败：门禁状态已变化')
  } finally {
    busyId.value = ''
  }
}

async function rollback(g) {
  if (!confirm('确定回退 v' + g.version + '？问答引用与共享链接将恢复到 v' + g.publishedVersion + '。')) return
  const res = await releaseStore.rollbackGate(g.id, (rollbackNoteMap.value[g.id] || '').trim(), auth.user)
  if (res.status === 'ok') rollbackNoteMap.value[g.id] = ''
  else if (res.status === 'denied' || res.status === 'guest') alert('只有管理员可以回退版本。')
  else alert('操作失败：门禁状态已变化')
}

function impactIcon(type) {
  return { citation: '🤖', ticket: '📮', share: '🔗' }[type] || '•'
}

// 豁免发布检查项（跨角色审批：负责人级由拥有者/管理员豁免，管理员级仅管理员）
const canWaive = (g, c) => canWaiveCheck(g, c, docById.value[g.docId] || null, auth.user?.id, auth.user?.role)

async function waive(g, c) {
  const note = window.prompt('豁免说明（将写入门禁留痕，可留空）：') || ''
  const res = await releaseStore.waiveCheck(g.id, c.key, note, auth.user)
  if (res.status === 'denied') alert('该检查项需 ' + (c.approverRole === 'admin' ? '管理员' : '文档负责人') + ' 豁免。')
  else if (res.status !== 'ok') alert('操作失败：检查项状态已变化')
}

// 重新评估发布检查：外部条件解除（工单解决/复核通过/评审完结/退役处理）后恢复流转
async function recheck(g) {
  const res = await releaseStore.recheckGate(g.id, auth.user)
  if (res.status === 'ok') {
    if (res.emerged?.length) alert('重新评估发现新增阻断 ' + res.emerged.length + ' 项，已回写门禁单。')
  } else if (res.status === 'denied') {
    alert('仅发起人、文档负责人或管理员可以重新评估。')
  } else if (res.status !== 'closed') {
    alert('操作失败：门禁状态已变化')
  }
}

function checkIcon(type) {
  return { review: '📝', freshness: '🧊', gap: '📮', retirement: '🗄️' }[type] || '•'
}

onMounted(async () => {
  await Promise.all([releaseStore.loadAll(), kb.loadAll()])
})
</script>

<template>
  <div class="gc-page">
    <header class="head">
      <h2>🚦 发布门禁</h2>
      <p class="sub">编辑者提交版本后关联受影响的问答引用、缺口工单与共享链接，并统一评估评审结论、知识保鲜、未解决缺口与退役关系 → 负责人确认影响、豁免负责人级检查 → 管理员豁免管理级检查并审批放行或回退；阻断原因实时回写门禁单，条件解除后重新评估自动恢复。</p>
      <div class="tabs">
        <button :class="{ on: tab === 'todo' }" @click="tab = 'todo'">待我处理 <em>{{ counts.todo }}</em></button>
        <button :class="{ on: tab === 'mine' }" @click="tab = 'mine'">我提交的 <em>{{ counts.mine }}</em></button>
        <button :class="{ on: tab === 'all' }" @click="tab = 'all'">全部记录 <em>{{ counts.all }}</em></button>
      </div>
    </header>

    <div v-if="!list.length" class="empty card">
      <div class="ico">🚦</div>
      {{ tab === 'todo' ? '暂无待你确认或审批的发布门禁' : tab === 'mine' ? '你还没有提交过发布门禁' : '暂无发布门禁记录' }}
    </div>

    <div v-else class="gate-list">
      <div v-for="g in list" :key="g.id" class="gate card">
        <div class="g-top" @click="docById[g.docId] && router.push('/docs/' + g.docId)">
          <div class="g-main">
            <span class="g-doc-title">{{ docById[g.docId]?.title || g.docTitle || '已删除文档' }}</span>
            <DocPill v-if="docById[g.docId]" :doc="docById[g.docId]" />
          </div>
          <div class="g-side">
            <span class="st" :class="gateStatusCls(g.status)">{{ gateStatusLabel(g.status) }}</span>
            <span class="g-time">{{ formatDate(g.createdAt) }}</span>
          </div>
        </div>

        <div class="g-info">
          <span>{{ userName(g.submittedBy) }} 提交</span>
          <span class="g-ver">v{{ g.publishedVersion }} → v{{ g.version }}</span>
          <span v-if="changedFields(g).length" class="g-fields">变更：{{ fieldLabels(changedFields(g)).join('、') }}</span>
          <span v-if="g.confirmedAt" class="g-confirmed">负责人 {{ userName(g.confirmedBy) }} 已确认</span>
          <span v-if="g.decidedAt" class="g-decided">{{ userName(g.decidedBy) }} 于 {{ formatFull(g.decidedAt) }} {{ gateStatusLabel(g.status) }}</span>
        </div>
        <div v-if="g.note" class="g-note">变更说明：“{{ g.note }}”</div>
        <div v-if="g.decisionNote" class="g-note">审批意见：“{{ g.decisionNote }}”</div>
        <div v-if="g.rollbackNote" class="g-note">回退说明：“{{ g.rollbackNote }}”</div>

        <!-- 影响项 -->
        <div class="impacts">
          <div class="imp-head">
            受影响关联（{{ impactCounts(g.impacts).total }}）：
            🤖 问答引用 {{ impactCounts(g.impacts).citation }} ·
            📮 缺口工单 {{ impactCounts(g.impacts).ticket }} ·
            🔗 共享链接 {{ impactCounts(g.impacts).share }}
            <span v-if="g.status === GATE.PENDING_CONFIRM" class="imp-progress">已确认 {{ impactCounts(g.impacts).confirmed }}/{{ impactCounts(g.impacts).total }}</span>
          </div>
          <div v-if="!g.impacts.length" class="imp-empty">无关联影响项</div>
          <div v-for="it in g.impacts" :key="it.key" class="impact" :class="'im-' + it.status">
            <span class="im-ico">{{ impactIcon(it.type) }}</span>
            <div class="im-body">
              <div class="im-title">{{ it.title }}</div>
              <div class="im-sub">
                <span class="im-type">{{ impactTypeLabel(it.type) }}</span>
                <span v-if="it.subtitle">{{ it.subtitle }}</span>
              </div>
            </div>
            <span class="im-state">{{ impactStatusLabel(it.status) }}</span>
            <button
              v-if="g.status === GATE.PENDING_CONFIRM && (isAdmin || g.ownerId === auth.user?.id) && it.status === IMPACT.PENDING"
              class="btn xs"
              @click="confirmItem(g, it.key)"
            >确认</button>
          </div>
        </div>

        <!-- 统一发布检查：评审结论 / 知识保鲜 / 未解决缺口 / 退役关系 -->
        <div v-if="g.status === GATE.PENDING_CONFIRM || g.status === GATE.PENDING_APPROVAL" class="checks">
          <div class="chk-head">
            <span class="chk-title">发布检查（{{ checkCounts(g.checks).blocked }} 项阻断 · {{ checkCounts(g.checks).waived }} 项已豁免）</span>
            <button class="btn xs ghost" @click="recheck(g)">↻ 重新检查</button>
          </div>
          <div v-if="g.blockedReasons?.length" class="blocked-banner">
            <div class="bb-title">⛔ 上次流转被阻断（{{ formatFull(g.blockedAt) }}），阻断原因已回写：</div>
            <div v-for="r in g.blockedReasons" :key="r.key" class="bb-item">· {{ r.title }} — {{ r.reason }}</div>
          </div>
          <div v-if="!(g.checks || []).length" class="chk-empty">✅ 评审结论 / 知识保鲜 / 未解决缺口 / 退役关系四项检查均通过</div>
          <div v-for="c in g.checks || []" :key="c.key" class="check" :class="'ck-' + c.state">
            <span class="ck-ico">{{ checkIcon(c.type) }}</span>
            <div class="ck-body">
              <div class="ck-title">{{ c.title }}</div>
              <div class="ck-sub">
                <span class="ck-type">{{ checkTypeLabel(c.type) }}</span>
                <span v-if="c.state === 'blocked'">{{ c.blockedReason }}（{{ checkApproverLabel(c.approverRole) }}）</span>
                <span v-else-if="c.state === 'waived'">已由 {{ userName(c.waivedBy) }} 豁免<span v-if="c.waiveNote">：“{{ c.waiveNote }}”</span></span>
                <span v-else>条件已解除</span>
              </div>
            </div>
            <span class="ck-state">{{ checkStateLabel(c.state) }}</span>
            <button v-if="canWaive(g, c)" class="btn xs" @click="waive(g, c)">豁免</button>
          </div>
        </div>
        <div v-else-if="checkCounts(g.checks).waived" class="checks-compact">
          发布检查：含 {{ checkCounts(g.checks).waived }} 项已豁免检查（跨角色确认留痕）
        </div>

        <!-- 操作区 -->
        <div v-if="g.status === GATE.PENDING_CONFIRM && (isAdmin || g.ownerId === auth.user?.id)" class="acts">
          <textarea :value="confirmNoteMap[g.id] || ''" rows="2" placeholder="影响确认意见（可选）" @input="confirmNoteMap[g.id] = $event.target.value"></textarea>
          <div class="act-row">
            <button class="btn sm ok-solid" @click="confirmAll(g)">确认影响并提交审批</button>
            <button v-if="g.submittedBy === auth.user?.id || isAdmin" class="btn sm ghost" @click="withdraw(g)">撤回升版</button>
          </div>
        </div>

        <div v-if="g.status === GATE.PENDING_APPROVAL && isAdmin" class="acts">
          <textarea :value="decideNoteMap[g.id] || ''" rows="2" placeholder="审批意见（可选，将写入留痕时间线）" @input="decideNoteMap[g.id] = $event.target.value"></textarea>
          <div class="act-row">
            <button class="btn sm danger-ghost" :disabled="busyId === g.id" @click="decide(g, 'reject')">✕ 驳回（不发布）</button>
            <button class="btn sm ok-solid" :disabled="busyId === g.id" @click="decide(g, 'approve')">✓ 审批放行并发布</button>
          </div>
        </div>

        <div v-if="g.status === GATE.RELEASED && isAdmin" class="acts released-acts">
          <div class="released-hint">已放行：问答引用切换至 v{{ g.version }}，共享链接已同步新版内容。如发现问题可回退。</div>
          <div class="act-row">
            <input :value="rollbackNoteMap[g.id] || ''" placeholder="回退原因（可选）" @input="rollbackNoteMap[g.id] = $event.target.value" />
            <button class="btn sm danger-ghost" @click="rollback(g)">↩ 回退至 v{{ g.publishedVersion }}</button>
          </div>
        </div>

        <details class="timeline">
          <summary>查看留痕时间线（{{ (g.timeline || []).length }}）</summary>
          <div v-for="(t, i) in g.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ gateTimelineLabel(t.action) }}</span>
            <span class="tl-who">{{ userName(t.by) }}</span>
            <span v-if="t.note" class="tl-note">“{{ t.note }}”</span>
            <span class="tl-tm">{{ formatFull(t.at) }}</span>
          </div>
        </details>
      </div>
    </div>

    <p v-if="!isAdmin && tab === 'todo'" class="foot-tip">非管理员仅能看到待你（文档负责人）确认影响的门禁；审批放行由管理员完成。</p>
  </div>
</template>

<style scoped>
.gc-page { max-width: 920px; margin: 0 auto; }
.head h2 { margin: 0 0 4px; }
.sub { color: var(--text-2); font-size: 13px; margin: 0 0 14px; }
.tabs { display: flex; gap: 8px; }
.tabs button { border: 1px solid var(--border); background: var(--panel); padding: 7px 16px; border-radius: 999px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.tabs button.on { background: var(--primary); border-color: var(--primary); color: #fff; font-weight: 600; }
.tabs em { font-style: normal; opacity: 0.7; margin-left: 2px; }
.gate-list { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.gate { padding: 16px 20px; }
.g-top { display: flex; justify-content: space-between; gap: 14px; cursor: pointer; }
.g-main { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.g-doc-title { font-weight: 700; font-size: 15px; }
.g-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; white-space: nowrap; }
.g-time { color: var(--text-3); font-size: 12px; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st-confirm { background: #e0e7ff; color: #4338ca; }
.st-pending { background: #fef3c7; color: #b45309; }
.st-ok { background: #dcfce7; color: #15803d; }
.st-no { background: #fee2e2; color: #b91c1c; }
.st-off { background: var(--panel-2); color: var(--text-3); }
.st-rollback { background: #ffedd5; color: #c2410c; }
.g-info { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 12px; font-size: 13px; color: var(--text-2); }
.g-ver { font-weight: 600; color: var(--primary); }
.g-fields { color: var(--text-3); font-size: 12px; }
.g-confirmed { color: #4338ca; font-size: 12px; }
.g-decided { font-size: 12px; color: var(--text-3); }
.g-note { margin-top: 8px; font-size: 13px; color: var(--text-2); background: var(--panel-2); border-radius: 8px; padding: 8px 12px; }
.impacts { margin-top: 12px; border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
.imp-head { font-size: 12.5px; font-weight: 600; color: var(--text-2); margin-bottom: 8px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.imp-progress { color: #4338ca; }
.imp-empty { font-size: 12.5px; color: var(--text-3); }
.impact { display: flex; gap: 10px; align-items: flex-start; padding: 7px 8px; border-radius: 8px; }
.impact.im-confirmed, .impact.im-released { background: #f0fdf4; }
.impact.im-reverted { opacity: 0.65; }
.im-ico { font-size: 14px; line-height: 1.5; }
.im-body { flex: 1; min-width: 0; }
.im-title { font-size: 13px; word-break: break-word; }
.im-sub { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 2px; font-size: 11.5px; color: var(--text-3); }
.im-type { background: var(--primary-weak); color: var(--primary); border-radius: 999px; padding: 0 8px; }
.im-state { font-size: 12px; color: #15803d; white-space: nowrap; }
.im-pending .im-state { color: #b45309; }
.im-reverted .im-state { color: var(--text-3); }
.btn.xs { padding: 2px 10px; font-size: 12px; }
.checks { margin-top: 12px; border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
.chk-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 600; color: var(--text-2); margin-bottom: 8px; }
.chk-empty { font-size: 12.5px; color: #15803d; }
.blocked-banner { background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
.bb-title { font-size: 12px; font-weight: 600; color: #b91c1c; margin-bottom: 4px; }
.bb-item { font-size: 12px; color: #7f1d1d; padding: 1px 0; word-break: break-word; }
.check { display: flex; gap: 10px; align-items: flex-start; padding: 7px 8px; border-radius: 8px; }
.check.ck-waived { background: #fffbeb; }
.check.ck-pass { opacity: 0.65; }
.ck-ico { font-size: 14px; line-height: 1.5; }
.ck-body { flex: 1; min-width: 0; }
.ck-title { font-size: 13px; word-break: break-word; }
.ck-sub { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 2px; font-size: 11.5px; color: var(--text-3); }
.ck-type { background: var(--panel-2); color: var(--text-2); border-radius: 999px; padding: 0 8px; }
.ck-state { font-size: 12px; white-space: nowrap; color: #b91c1c; }
.ck-waived .ck-state { color: #b45309; }
.ck-pass .ck-state { color: #15803d; }
.checks-compact { margin-top: 10px; font-size: 12px; color: #b45309; }
.acts { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 12px; }
.acts textarea, .acts input { width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; outline: none; }
.acts textarea { resize: vertical; }
.acts textarea:focus, .acts input:focus { border-color: var(--primary); }
.act-row { display: flex; gap: 8px; margin-top: 8px; }
.btn.ok-solid { background: #16a34a; border-color: #16a34a; color: #fff; }
.btn.ok-solid:hover { background: #15803d; color: #fff; }
.btn.danger-ghost { background: #fff; border-color: #f2555c; color: #b91c1c; }
.btn.danger-ghost:hover { background: #fef2f2; }
.released-hint { font-size: 12.5px; color: #15803d; margin-bottom: 8px; }
.timeline { margin-top: 10px; }
.timeline summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: var(--primary); min-width: 110px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
.foot-tip { margin-top: 14px; color: var(--text-3); font-size: 12px; text-align: center; }
</style>
