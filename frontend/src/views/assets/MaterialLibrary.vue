<template>
  <div class="p-7 pb-10 max-w-[1280px] mx-auto">
    <PageHead title="素材库">
      <template #sub>
        字体、素材包、关键词组与声音的统一管理入口 ·
        上传与管理仅管理员，运营只读；停用后对混剪匹配与剪辑字体下拉即时生效
      </template>
      <template #actions>
        <a-space>
          <a-button v-if="canWrite && tab === 'fonts'" type="primary" @click="openFontUpload">
            <template #icon><icon-plus /></template>上传字体
          </a-button>
          <a-button v-if="canWrite && tab === 'packs'" type="primary" @click="openPackUpload">
            <template #icon><icon-plus /></template>上传素材包
          </a-button>
          <a-button v-if="canWrite && tab === 'keywords'" type="primary" @click="openGroupEdit(null)">
            <template #icon><icon-plus /></template>新建关键词组
          </a-button>
        </a-space>
      </template>
    </PageHead>

    <a-tabs v-model:active-key="tab" type="line" class="mw-tabs">
      <a-tab-pane key="fonts">
        <template #title
          >字体库 <span class="mw-subtle">{{ fonts.length }}</span></template
        >
      </a-tab-pane>
      <a-tab-pane key="packs">
        <template #title
          >素材库 <span class="mw-subtle">{{ packs.length }}</span></template
        >
      </a-tab-pane>
      <a-tab-pane key="keywords">
        <template #title
          >关键词组 <span class="mw-subtle">{{ groups.length }}</span></template
        >
      </a-tab-pane>
      <a-tab-pane key="voices">
        <template #title
          >声音库 <span class="mw-subtle">{{ voices.length }}</span></template
        >
      </a-tab-pane>
      <a-tab-pane key="avatars">
        <template #title>数字人形象</template>
      </a-tab-pane>
    </a-tabs>

    <!-- ── 字体库（FR-F1~F5）────────────────────────────────── -->
    <section v-if="tab === 'fonts'">
      <div v-if="!fontsLoading && !enabledFontCount" class="mw-alert-banner mb-3">
        <icon-info-circle :size="14" />
        当前没有启用中的字体，剪辑字幕将使用 default
        字体（字体目录中文件名排序首个）。上传后需手动启用才会出现在剪辑字体下拉中。
      </div>
      <a-table :data="fonts" :loading="fontsLoading" row-key="id" :pagination="false" :bordered="{ cell: false }">
        <template #columns>
          <a-table-column title="字体" :width="240">
            <template #cell="{ record }">
              <div class="font-medium">{{ record.displayName }}</div>
              <div class="mw-subtle text-[12px]">{{ record.fileName }}</div>
            </template>
          </a-table-column>
          <a-table-column title="规格" :width="150">
            <template #cell="{ record }">
              <span class="mw-subtle">{{ extOf(record.fileName) }} · {{ fmtSize(record.sizeBytes) }}</span>
            </template>
          </a-table-column>
          <a-table-column title="商用授权" :width="260">
            <template #cell="{ record }">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="mw-tag" :class="licenseClass(record)">{{ licenseLabel(record.licenseType) }}</span>
                <span v-if="record.licenseType === 'other' && !record.licenseNote" class="mw-tag mw-tag-red"
                  >缺授权出处</span
                >
                <span
                  v-if="record.licenseNote"
                  class="mw-subtle text-[12px] truncate max-w-[150px]"
                  :title="record.licenseNote"
                >
                  {{ record.licenseNote }}
                </span>
              </div>
            </template>
          </a-table-column>
          <a-table-column title="成片引用" :width="100">
            <template #cell="{ record }">
              <span v-if="record.inUseCount" class="mw-tag mw-tag-yellow">{{ record.inUseCount }} 个版本</span>
              <span v-else class="mw-subtle">—</span>
            </template>
          </a-table-column>
          <a-table-column title="启用" :width="90">
            <template #cell="{ record }">
              <a-switch
                :model-value="record.enabled"
                size="small"
                :disabled="!canWrite"
                @change="toggleFont(record, $event as boolean)"
              />
            </template>
          </a-table-column>
          <a-table-column title="操作" :width="150">
            <template #cell="{ record }">
              <a-space v-if="canWrite">
                <a-button size="mini" @click="openFontEdit(record)">授权</a-button>
                <a-popconfirm content="删除后字体文件也会从字体目录移除，确定？" @ok="removeFont(record)">
                  <a-button size="mini" status="danger">删除</a-button>
                </a-popconfirm>
              </a-space>
              <span v-else class="mw-subtle">只读</span>
            </template>
          </a-table-column>
        </template>
      </a-table>
      <div class="mt-3 mw-subtle flex items-center gap-1">
        <icon-info-circle :size="13" />
        上传后默认「未启用」；授权类型为「其他 / 待核」时必须填写授权出处才能启用（字幕烧录属商用场景）。
      </div>
    </section>

    <!-- ── 素材包（FR-P1~P4）────────────────────────────────── -->
    <section v-else-if="tab === 'packs'">
      <div class="flex items-center gap-3 mb-3">
        <a-select v-model="packLine" :style="{ width: '150px' }" allow-clear placeholder="全部线">
          <a-option value="manager" label="经理 IP" />
          <a-option value="kos" label="员工 KOS" />
          <a-option value="persona" label="素人矩阵" />
        </a-select>
        <span class="mw-subtle">{{ filteredPacks.length }} 个素材包 · 停用后混剪匹配即时不再取用</span>
      </div>

      <a-spin :loading="packsLoading" class="w-full">
        <div v-if="filteredPacks.length" class="grid grid-cols-2 gap-3">
          <div v-for="p in filteredPacks" :key="p.id" class="mw-card p-4">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="text-[14px] font-medium truncate">{{ p.name }}</span>
                  <LineTag v-if="p.line" :line="p.line" />
                </div>
                <div class="mw-subtle text-[12px] mt-1">
                  {{ p.itemCount }} 项素材 · {{ fmtTime(p.createdAt) }}
                  <span v-if="!p.licenseNote" class="mw-tag mw-tag-yellow ml-1">未标授权出处</span>
                </div>
              </div>
              <a-switch
                :model-value="p.enabled === 1"
                size="small"
                :disabled="!canWrite"
                @change="togglePack(p, $event as boolean)"
              />
            </div>
            <div class="flex items-center justify-between mt-3">
              <a-button size="mini" @click="openPackDetail(p)">查看素材</a-button>
              <a-button v-if="canWrite" size="mini" status="danger" @click="removePack(p)">删除</a-button>
            </div>
          </div>
        </div>
        <a-empty v-else-if="!packsLoading" description="还没有素材包，上传 zip 或多个片段即可创建" />
      </a-spin>
    </section>

    <!-- ── 关键词组（FR-K1）────────────────────────────────── -->
    <section v-else-if="tab === 'keywords'">
      <a-table :data="groups" :loading="groupsLoading" row-key="id" :pagination="false" :bordered="{ cell: false }">
        <template #columns>
          <a-table-column title="组名" data-index="name" :width="180" />
          <a-table-column title="关键词" :width="260">
            <template #cell="{ record }">
              <div class="flex flex-wrap gap-1">
                <span v-for="k in record.keywords" :key="k" class="mw-tag mw-tag-gray">{{ k }}</span>
              </div>
            </template>
          </a-table-column>
          <a-table-column title="关联素材包" :width="220">
            <template #cell="{ record }">
              <span v-if="!record.packIds.length" class="mw-subtle">全部启用包</span>
              <div v-else class="flex flex-wrap gap-1">
                <span v-for="id in record.packIds" :key="id" class="mw-tag mw-tag-blue">{{ packNameOf(id) }}</span>
              </div>
            </template>
          </a-table-column>
          <a-table-column title="片段时长" :width="130">
            <template #cell="{ record }">
              <span class="mw-subtle"
                >{{ (record.durationMinMs / 1000).toFixed(1) }}–{{ (record.durationMaxMs / 1000).toFixed(1) }}s</span
              >
            </template>
          </a-table-column>
          <a-table-column title="选材" :width="90">
            <template #cell="{ record }">
              <span class="mw-tag mw-tag-gray">{{ record.selectionMode === 'sequential' ? '顺序' : '随机' }}</span>
            </template>
          </a-table-column>
          <a-table-column title="启用" :width="80">
            <template #cell="{ record }">
              <a-switch
                :model-value="record.enabled === 1"
                size="small"
                :disabled="!canWrite"
                @change="toggleGroup(record, $event as boolean)"
              />
            </template>
          </a-table-column>
          <a-table-column title="排序" :width="110">
            <template #cell="{ record, rowIndex }">
              <a-space v-if="canWrite">
                <a-button size="mini" :disabled="rowIndex === 0" @click="moveGroup(rowIndex, -1)">↑</a-button>
                <a-button size="mini" :disabled="rowIndex === groups.length - 1" @click="moveGroup(rowIndex, 1)"
                  >↓</a-button
                >
              </a-space>
              <span v-else class="mw-subtle">{{ record.sort }}</span>
            </template>
          </a-table-column>
          <a-table-column title="操作" :width="130">
            <template #cell="{ record }">
              <a-space v-if="canWrite">
                <a-button size="mini" @click="openGroupEdit(record)">编辑</a-button>
                <a-popconfirm content="确定删除该关键词组？" @ok="removeGroup(record)">
                  <a-button size="mini" status="danger">删除</a-button>
                </a-popconfirm>
              </a-space>
              <span v-else class="mw-subtle">只读</span>
            </template>
          </a-table-column>
        </template>
      </a-table>
      <div class="mt-3 mw-subtle flex items-center gap-1">
        <icon-info-circle :size="13" />
        关键词组驱动混剪的按语义取素材：组内关键词命中素材 tags 即候选；视频创作页只能选择、编辑请在此处完成。
      </div>
    </section>

    <!-- ── 声音库（FR-V1，人物库只读聚合）──────────────────── -->
    <section v-else-if="tab === 'voices'">
      <div class="flex items-center gap-3 mb-3">
        <a-select v-model="voiceLine" :style="{ width: '150px' }" allow-clear placeholder="全部线">
          <a-option value="manager" label="经理 IP" />
          <a-option value="kos" label="员工 KOS" />
          <a-option value="persona" label="素人矩阵" />
        </a-select>
        <span class="mw-subtle">{{ filteredVoices.length }} 个声音档案 · 授权核验与试听管理在人物库完成</span>
      </div>
      <a-table
        :data="filteredVoices"
        :loading="voicesLoading"
        row-key="voiceId"
        :pagination="false"
        :bordered="{ cell: false }"
      >
        <template #columns>
          <a-table-column title="人物" :width="180">
            <template #cell="{ record }">
              <a-link @click="gotoPersona(record.personaId)">{{ record.personaName }}</a-link>
            </template>
          </a-table-column>
          <a-table-column title="声音" :width="200">
            <template #cell="{ record }">
              <div>{{ record.voiceName }}</div>
              <div class="mw-subtle text-[12px]">{{ record.isSample ? '样本音' : '克隆音' }} · {{ record.status }}</div>
            </template>
          </a-table-column>
          <a-table-column title="所属线" :width="120">
            <template #cell="{ record }"><LineTag :line="record.line" /></template>
          </a-table-column>
          <a-table-column title="授权状态" :width="130">
            <template #cell="{ record }">
              <span class="mw-tag" :class="voiceLicenseClass(record)">{{
                VOICE_LICENSE_LABELS[voiceLicenseStateOf(record)]
              }}</span>
            </template>
          </a-table-column>
          <a-table-column title="创建时间" :width="160">
            <template #cell="{ record }"
              ><span class="mw-subtle">{{ fmtTime(record.createdAt) }}</span></template
            >
          </a-table-column>
          <a-table-column title="操作" :width="120">
            <template #cell="{ record }">
              <a-button size="mini" @click="gotoPersona(record.personaId)">去人物库</a-button>
            </template>
          </a-table-column>
        </template>
      </a-table>
    </section>

    <!-- ── 数字人形象（FR-X1：只给入口，不复制视图）──────────── -->
    <section v-else>
      <div class="mw-card p-6 max-w-[560px]">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-[10px] bg-[var(--mw-primary-bg)] flex items-center justify-center">
            <icon-user :size="18" class="text-[color:var(--mw-primary)]" />
          </div>
          <div>
            <div class="text-[15px] font-medium">数字人形象在人物库管理</div>
            <div class="mw-subtle text-[12px] mt-0.5">
              形象五视图、绑定声音与账号归属都在人物档案内，素材库不复制数据
            </div>
          </div>
        </div>
        <a-button class="mt-4" type="primary" @click="router.push('/people')">前往人物库</a-button>
      </div>
    </section>

    <!-- ── 字体上传 / 授权编辑 ─────────────────────────────── -->
    <a-modal
      v-model:visible="fontModalVisible"
      :title="fontEditing ? `编辑授权：${fontEditing.displayName}` : '上传字体'"
      :ok-loading="saving"
      :ok-text="fontEditing ? '保存' : '上传'"
      @ok="submitFont"
      @cancel="fontModalVisible = false"
    >
      <div class="flex flex-col gap-3">
        <div v-if="!fontEditing">
          <a-upload v-model:file-list="fontFiles" :auto-upload="false" accept=".otf,.ttf,.ttc" :limit="1" draggable />
          <div class="mw-subtle text-[12px] mt-1">支持 .otf / .ttf / .ttc，单文件 ≤ 30MB；上传后默认未启用。</div>
        </div>
        <a-input v-model="fontForm.displayName" placeholder="展示名称（默认取文件名）" />
        <a-select v-model="fontForm.licenseType" placeholder="商用授权类型">
          <a-option value="ofl" label="开源授权 OFL" />
          <a-option value="commercial" label="已购商用授权" />
          <a-option value="other" label="其他 / 待核验" />
        </a-select>
        <a-textarea
          v-model="fontForm.licenseNote"
          :auto-size="{ minRows: 2, maxRows: 4 }"
          placeholder="授权出处（授权书编号 / 采购渠道 / 官网链接）；选「其他」时必填才能启用"
        />
        <a-progress v-if="uploading" :percent="uploadPercent" size="small" />
      </div>
    </a-modal>

    <!-- ── 素材包上传 ──────────────────────────────────────── -->
    <a-modal
      v-model:visible="packModalVisible"
      title="上传素材包"
      :ok-loading="saving"
      ok-text="开始上传"
      @ok="submitPack"
      @cancel="packModalVisible = false"
    >
      <div class="flex flex-col gap-3">
        <a-input v-model="packForm.name" placeholder="素材包名称" />
        <div class="flex gap-2">
          <a-select v-model="packForm.line" :style="{ width: '150px' }" allow-clear placeholder="所属线（可选）">
            <a-option value="manager" label="经理 IP" />
            <a-option value="kos" label="员工 KOS" />
            <a-option value="persona" label="素人矩阵" />
          </a-select>
          <a-input v-model="packForm.licenseNote" placeholder="授权出处（可选，建议填写）" />
        </div>
        <a-upload
          v-model:file-list="packFiles"
          :auto-upload="false"
          multiple
          accept=".zip,.mp4,.mov,.webm,.jpg,.jpeg,.png"
          draggable
        />
        <div class="mw-subtle text-[12px]">
          投递方式二选一：打包一个 .zip（推荐，保留目录结构），或直接多选片段/图片（一次最多 20 个，单文件 ≤ 200MB）。
        </div>
        <a-progress v-if="uploading" :percent="uploadPercent" size="small" />
      </div>
    </a-modal>

    <!-- ── 素材包详情 / item 补标 ──────────────────────────── -->
    <a-drawer v-model:visible="detailVisible" :width="640" :title="detailPack?.name ?? '素材包'" unmount-on-close>
      <a-spin :loading="itemsLoading" class="w-full">
        <div v-if="items.length" class="grid grid-cols-3 gap-3">
          <div v-for="it in items" :key="it.id" class="border border-[var(--mw-border)] rounded-[8px] overflow-hidden">
            <div class="h-[92px] bg-[var(--mw-primary-bg)] flex items-center justify-center">
              <img v-if="it.thumbUrl" :src="it.thumbUrl" class="w-full h-full object-cover" alt="" />
              <icon-image v-else :size="18" class="mw-subtle" />
            </div>
            <div class="p-2">
              <div class="mw-subtle text-[12px]">{{ it.isImage ? '图片' : fmtDuration(it.durationMs) }}</div>
              <div class="flex flex-wrap gap-1 mt-1">
                <span v-for="t in it.tags" :key="t" class="mw-tag mw-tag-gray">{{ t }}</span>
                <span v-if="!it.tags.length" class="mw-subtle text-[12px]">无标签</span>
              </div>
              <a-button v-if="canWrite" size="mini" long class="mt-1.5" @click="openItemTags(it)">编辑标签</a-button>
            </div>
          </div>
        </div>
        <a-empty v-else-if="!itemsLoading" description="该素材包暂无可用素材" />
      </a-spin>
    </a-drawer>

    <a-modal
      v-model:visible="itemTagVisible"
      title="编辑素材标签"
      :ok-loading="saving"
      @ok="submitItemTags"
      @cancel="itemTagVisible = false"
    >
      <a-input-tag v-model="itemTagForm" placeholder="输入标签后回车（单个 ≤ 20 字，最多 20 个）" allow-clear />
    </a-modal>

    <!-- ── 关键词组编辑 ───────────────────────────────────── -->
    <a-modal
      v-model:visible="groupModalVisible"
      :title="groupEditing ? `编辑关键词组：${groupEditing.name}` : '新建关键词组'"
      :ok-loading="saving"
      :width="560"
      @ok="submitGroup"
      @cancel="groupModalVisible = false"
    >
      <div class="flex flex-col gap-3">
        <a-input v-model="groupForm.name" placeholder="组名（如：投教术语）" />
        <a-input-tag v-model="groupForm.keywords" placeholder="关键词，回车添加" allow-clear />
        <a-select v-model="groupForm.packIds" multiple placeholder="关联素材包（留空 = 全部启用包）" allow-clear>
          <a-option v-for="p in packs" :key="p.id" :value="p.id" :label="p.name" />
        </a-select>
        <div class="flex items-center gap-2">
          <a-input-number
            v-model="groupForm.durationMinMs"
            :min="100"
            :step="100"
            :style="{ width: '150px' }"
            placeholder="最短 ms"
          />
          <span class="mw-subtle">—</span>
          <a-input-number
            v-model="groupForm.durationMaxMs"
            :min="200"
            :step="100"
            :style="{ width: '150px' }"
            placeholder="最长 ms"
          />
          <span class="mw-subtle text-[12px]">片段时长区间</span>
        </div>
        <div class="flex items-center gap-4">
          <a-radio-group v-model="groupForm.selectionMode" type="button" size="small">
            <a-radio value="random">随机</a-radio>
            <a-radio value="sequential">顺序</a-radio>
          </a-radio-group>
          <a-switch v-model="groupForm.enabled" size="small" />
          <span class="mw-subtle text-[12px]">启用</span>
        </div>
      </div>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Message } from '@arco-design/web-vue'
import { IconImage, IconInfoCircle, IconPlus, IconUser } from '@arco-design/web-vue/es/icon'
import type { FileItem } from '@arco-design/web-vue/es/upload/interfaces'
import PageHead from '@/components/PageHead.vue'
import LineTag from '@/components/LineTag.vue'
import { useAuthStore } from '@/stores/auth'
import {
  LICENSE_LABELS,
  VOICE_LICENSE_LABELS,
  createKeywordGroup,
  deleteFont,
  deleteKeywordGroup,
  deleteMaterialPack,
  listFonts,
  listKeywordGroups,
  listMaterialItems,
  listMaterialPacks,
  listVoiceLibrary,
  patchFont,
  patchKeywordGroup,
  patchMaterialItem,
  patchMaterialPack,
  uploadFont,
  uploadMaterialPack,
  voiceLicenseStateOf,
  type FontItem,
  type KeywordGroupInput,
  type KeywordGroupView,
  type LicenseType,
  type MaterialItemView,
  type MaterialPackView,
  type VoiceLibraryItem,
} from '@/api/material'

/**
 * 素材库页（任务书 ML3 / §7）：四 Tab 全部接真。
 *  - 字体库：上传（默认未启用）→ 授权标记 → 启用 → 剪辑字体下拉；删除有引用守卫；
 *  - 素材库：包卡片 + 启停 + 上传 zip/多文件 + 详情 items 网格 + tags 补标；
 *  - 关键词组：完整 CRUD（视频创作页只读选择）；
 *  - 声音库：人物库声音档案只读聚合，按线筛选，管理链回人物库；
 *  - 数字人形象：入口卡片（不复制视图）。
 * 写操作仅管理员（A6），ops / reviewer 看得到但按钮隐藏。
 */

type TabKey = 'fonts' | 'packs' | 'keywords' | 'voices' | 'avatars'

const router = useRouter()
const auth = useAuthStore()
const canWrite = computed(() => auth.hasRole('admin'))

const tab = ref<TabKey>('fonts')

/* ── 字体 ─────────────────────────────────────────────────── */
const fonts = ref<FontItem[]>([])
const fontsLoading = ref(false)
const fontModalVisible = ref(false)
const fontEditing = ref<FontItem | null>(null)
const fontFiles = ref<FileItem[]>([])
const fontForm = reactive({ displayName: '', licenseType: 'other' as LicenseType, licenseNote: '' })
const enabledFontCount = computed(() => fonts.value.filter((f) => f.enabled).length)

async function loadFonts(): Promise<void> {
  fontsLoading.value = true
  try {
    fonts.value = (await listFonts()).items
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    fontsLoading.value = false
  }
}

function openFontUpload(): void {
  fontEditing.value = null
  fontFiles.value = []
  Object.assign(fontForm, { displayName: '', licenseType: 'other', licenseNote: '' })
  fontModalVisible.value = true
}

function openFontEdit(f: FontItem): void {
  fontEditing.value = f
  Object.assign(fontForm, { displayName: f.displayName, licenseType: f.licenseType, licenseNote: f.licenseNote ?? '' })
  fontModalVisible.value = true
}

async function submitFont(): Promise<void> {
  saving.value = true
  try {
    if (fontEditing.value) {
      await patchFont(fontEditing.value.id, {
        displayName: fontForm.displayName,
        licenseType: fontForm.licenseType,
        licenseNote: fontForm.licenseNote,
      })
      Message.success('授权信息已保存')
    } else {
      const file = fontFiles.value[0]?.file
      if (!file) {
        Message.warning('请选择字体文件')
        return
      }
      uploading.value = true
      uploadPercent.value = 0
      const created = await uploadFont(
        file,
        {
          displayName: fontForm.displayName || undefined,
          licenseType: fontForm.licenseType,
          licenseNote: fontForm.licenseNote,
        },
        (p) => (uploadPercent.value = p),
      )
      Message.success(`「${created.displayName}」已上传，默认未启用`)
    }
    fontModalVisible.value = false
    await loadFonts()
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    saving.value = false
    uploading.value = false
    uploadPercent.value = 0
  }
}

async function toggleFont(f: FontItem, next: boolean): Promise<void> {
  try {
    await patchFont(f.id, { enabled: next })
    Message.success(next ? '已启用，剪辑字体下拉即时可选' : '已停用，剪辑字体下拉即时移除')
  } catch (e) {
    Message.error((e as Error).message)
  }
  await loadFonts()
}

async function removeFont(f: FontItem): Promise<void> {
  try {
    await deleteFont(f.id)
    Message.success('字体已删除')
  } catch (e) {
    Message.error((e as Error).message)
  }
  await loadFonts()
}

/** 授权类型文案（record 来自表格插槽，类型为 any，这里收敛一次） */
function licenseLabel(t: string): string {
  return LICENSE_LABELS[t as LicenseType] ?? '其他 / 待核'
}

function licenseClass(f: FontItem): string {
  if (f.licenseType === 'ofl') return 'mw-tag-green'
  if (f.licenseType === 'commercial') return 'mw-tag-blue'
  return f.licenseNote ? 'mw-tag-yellow' : 'mw-tag-red'
}

/* ── 素材包 ───────────────────────────────────────────────── */
const packs = ref<MaterialPackView[]>([])
const packsLoading = ref(false)
const packLine = ref<string | undefined>(undefined)
const packModalVisible = ref(false)
const packFiles = ref<FileItem[]>([])
const packForm = reactive({ name: '', line: undefined as string | undefined, licenseNote: '' })
const filteredPacks = computed(() =>
  packLine.value ? packs.value.filter((p) => p.line === packLine.value) : packs.value,
)

const detailVisible = ref(false)
const detailPack = ref<MaterialPackView | null>(null)
const items = ref<MaterialItemView[]>([])
const itemsLoading = ref(false)
const itemTagVisible = ref(false)
const itemTagTarget = ref<MaterialItemView | null>(null)
const itemTagForm = ref<string[]>([])

async function loadPacks(): Promise<void> {
  packsLoading.value = true
  try {
    packs.value = await listMaterialPacks()
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    packsLoading.value = false
  }
}

function openPackUpload(): void {
  packFiles.value = []
  Object.assign(packForm, { name: '', line: undefined, licenseNote: '' })
  packModalVisible.value = true
}

async function submitPack(): Promise<void> {
  const files = packFiles.value.map((f) => f.file).filter((f): f is File => !!f)
  if (!files.length) {
    Message.warning('请选择 zip 或素材文件')
    return
  }
  if (!packForm.name.trim()) {
    Message.warning('请填写素材包名称')
    return
  }
  saving.value = true
  uploading.value = true
  uploadPercent.value = 0
  try {
    const pack = await uploadMaterialPack(
      { name: packForm.name.trim(), line: packForm.line ?? null, licenseNote: packForm.licenseNote || null, files },
      (p) => (uploadPercent.value = p),
    )
    Message.success(`「${pack.name}」已导入 ${pack.itemCount} 项素材`)
    packModalVisible.value = false
    await loadPacks()
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    saving.value = false
    uploading.value = false
    uploadPercent.value = 0
  }
}

async function togglePack(p: MaterialPackView, next: boolean): Promise<void> {
  try {
    await patchMaterialPack(p.id, { enabled: next })
    Message.success(next ? '已启用' : '已停用，混剪匹配即时不再取用')
  } catch (e) {
    Message.error((e as Error).message)
  }
  await loadPacks()
}

async function removePack(p: MaterialPackView): Promise<void> {
  try {
    await deleteMaterialPack(p.id)
    Message.success('素材包已删除')
  } catch (e) {
    // MATERIAL_PACK_IN_USE 等守卫错误直接展示服务端话术
    Message.error((e as Error).message)
  }
  await loadPacks()
}

async function openPackDetail(p: MaterialPackView): Promise<void> {
  detailPack.value = p
  detailVisible.value = true
  items.value = []
  itemsLoading.value = true
  try {
    items.value = await listMaterialItems(p.id)
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    itemsLoading.value = false
  }
}

function openItemTags(it: MaterialItemView): void {
  itemTagTarget.value = it
  itemTagForm.value = [...it.tags]
  itemTagVisible.value = true
}

async function submitItemTags(): Promise<void> {
  const target = itemTagTarget.value
  const pack = detailPack.value
  if (!target || !pack) return
  saving.value = true
  try {
    const r = await patchMaterialItem(pack.id, target.id, itemTagForm.value)
    target.tags = r.tags
    Message.success('标签已保存')
    itemTagVisible.value = false
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    saving.value = false
  }
}

/* ── 关键词组 ─────────────────────────────────────────────── */
const groups = ref<KeywordGroupView[]>([])
const groupsLoading = ref(false)
const groupModalVisible = ref(false)
const groupEditing = ref<KeywordGroupView | null>(null)
const groupForm = reactive<KeywordGroupInput>({
  name: '',
  keywords: [],
  packIds: [],
  durationMinMs: 800,
  durationMaxMs: 3000,
  selectionMode: 'random',
  enabled: true,
  sort: 100,
})

async function loadGroups(): Promise<void> {
  groupsLoading.value = true
  try {
    groups.value = await listKeywordGroups()
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    groupsLoading.value = false
  }
}

function packNameOf(id: string): string {
  return packs.value.find((p) => p.id === id)?.name ?? id
}

function openGroupEdit(g: KeywordGroupView | null): void {
  groupEditing.value = g
  Object.assign(groupForm, {
    name: g?.name ?? '',
    keywords: g ? [...g.keywords] : [],
    packIds: g ? [...g.packIds] : [],
    durationMinMs: g?.durationMinMs ?? 800,
    durationMaxMs: g?.durationMaxMs ?? 3000,
    selectionMode: g?.selectionMode ?? 'random',
    enabled: g ? g.enabled === 1 : true,
    sort: g?.sort ?? groups.value.length * 10 + 100,
  })
  groupModalVisible.value = true
}

async function submitGroup(): Promise<void> {
  if (!groupForm.name.trim()) {
    Message.warning('请填写组名')
    return
  }
  if (!groupForm.keywords.length) {
    Message.warning('关键词不能为空')
    return
  }
  if (groupForm.durationMinMs >= groupForm.durationMaxMs) {
    Message.warning('最小时长须小于最大时长')
    return
  }
  saving.value = true
  try {
    const payload: KeywordGroupInput = {
      name: groupForm.name.trim(),
      keywords: groupForm.keywords.map((k) => k.trim()).filter(Boolean),
      packIds: groupForm.packIds,
      durationMinMs: groupForm.durationMinMs,
      durationMaxMs: groupForm.durationMaxMs,
      selectionMode: groupForm.selectionMode,
      enabled: groupForm.enabled,
      sort: groupForm.sort,
    }
    if (groupEditing.value) await patchKeywordGroup(groupEditing.value.id, payload)
    else await createKeywordGroup(payload)
    Message.success('关键词组已保存')
    groupModalVisible.value = false
    await loadGroups()
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    saving.value = false
  }
}

async function toggleGroup(g: KeywordGroupView, next: boolean): Promise<void> {
  try {
    await patchKeywordGroup(g.id, { enabled: next })
    Message.success(next ? '已启用' : '已停用，混剪匹配跳过该组')
  } catch (e) {
    Message.error((e as Error).message)
  }
  await loadGroups()
}

async function removeGroup(g: KeywordGroupView): Promise<void> {
  try {
    await deleteKeywordGroup(g.id)
    Message.success('关键词组已删除')
  } catch (e) {
    Message.error((e as Error).message)
  }
  await loadGroups()
}

/** 排序上下移：交换相邻两行的 sort 值（写回后重载，服务端 sort 为准） */
async function moveGroup(index: number, delta: number): Promise<void> {
  const a = groups.value[index]
  const b = groups.value[index + delta]
  if (!a || !b) return
  try {
    await patchKeywordGroup(a.id, { sort: b.sort })
    await patchKeywordGroup(b.id, { sort: a.sort })
  } catch (e) {
    Message.error((e as Error).message)
  }
  await loadGroups()
}

/* ── 声音库 ───────────────────────────────────────────────── */
const voices = ref<VoiceLibraryItem[]>([])
const voicesLoading = ref(false)
const voiceLine = ref<string | undefined>(undefined)
const filteredVoices = computed(() =>
  voiceLine.value ? voices.value.filter((v) => v.line === voiceLine.value) : voices.value,
)

async function loadVoices(): Promise<void> {
  voicesLoading.value = true
  try {
    voices.value = await listVoiceLibrary()
  } catch (e) {
    Message.error((e as Error).message)
  } finally {
    voicesLoading.value = false
  }
}

function voiceLicenseClass(v: VoiceLibraryItem): string {
  const s = voiceLicenseStateOf(v)
  return s === 'verified' ? 'mw-tag-green' : s === 'pending' ? 'mw-tag-yellow' : 'mw-tag-red'
}

function gotoPersona(personaId: string): void {
  router.push({ path: '/people', query: { persona: personaId } })
}

/* ── 通用 ─────────────────────────────────────────────────── */
const saving = ref(false)
const uploading = ref(false)
const uploadPercent = ref(0)

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '—' : name.slice(i + 1).toUpperCase()
}

function fmtSize(bytes: number): string {
  if (!bytes) return '—'
  const mb = bytes / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`
}

function fmtTime(v: string | null): string {
  return v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—'
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '时长未知'
  return `${(ms / 1000).toFixed(1)}s`
}

/** 首次进入某 Tab 时按需加载，避免一次性打 4 个接口 */
const loaded: Record<string, boolean> = {}
watch(
  tab,
  (key) => {
    if (loaded[key]) return
    loaded[key] = true
    if (key === 'fonts') void loadFonts()
    else if (key === 'packs') void loadPacks()
    else if (key === 'keywords') {
      void loadGroups()
      // 关键词组要显示包名，包列表必须就绪
      if (!packs.value.length) void loadPacks()
    } else if (key === 'voices') void loadVoices()
  },
  { immediate: true },
)
</script>
