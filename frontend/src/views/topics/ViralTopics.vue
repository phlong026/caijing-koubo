<template>
  <div class="p-7 pb-10 max-w-[1440px] mx-auto">
    <PageHead title="爆款选题">
      <template #sub>
        <div>
          <div>先选资料，再人工生成与分配选题；对标账号按设定周期自动检查并识别爆款。</div>
          <div class="mt-0.5">
            {{ todayText }} ·
            <span v-if="tab === 'news'">
              资讯库 {{ news.total }} 条<template v-if="news.lastRefresh">
                · 上次采集新增 {{ news.lastRefresh.inserted }} 条</template
              >
            </span>
            <span v-else>
              监控账号 {{ bench.accounts.length }} 个<template v-if="bench.quota">
                · 预计 {{ bench.quota.dailyCalls }} 次/天 · ¥{{ bench.quota.estimatedCost.toFixed(2) }}/天</template
              >
            </span>
          </div>
        </div>
      </template>
      <template #actions>
        <template v-if="tab === 'bench'">
          <a-button @click="openAddAccount">
            <template #icon><icon-plus /></template>添加账号链接
          </a-button>
          <a-button type="outline" @click="openExtractLink">
            视频直接提取改写<icon-right class="ml-1" />
          </a-button>
        </template>
        <a-button v-else @click="onRefreshNews" :loading="news.refreshing">
          <template #icon><icon-refresh /></template>采集最新资讯
        </a-button>
      </template>
    </PageHead>

    <a-tabs v-model:active-key="tab" type="line" class="mw-tabs">
      <!-- ============ 热点资讯 ============ -->
      <a-tab-pane key="news" title="热点资讯">
        <div class="flex gap-5 items-start mt-1">
          <!-- 左列 -->
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <button
                v-for="c in news.chips"
                :key="c.key"
                class="px-3.5 h-8 rounded-full text-[13px] border transition-colors"
                :class="news.category === c.key
                  ? 'bg-[var(--mw-primary-bg)] border-[color:var(--mw-primary-soft)] text-[color:var(--mw-primary)] font-medium'
                  : 'bg-white border-[var(--mw-border)] text-[var(--mw-text2)] hover:border-[color:var(--mw-primary-soft)]'"
                @click="news.setCategory(c.key)"
              >
                {{ c.label }} <span class="text-[var(--mw-text3)]">{{ c.count }}</span>
              </button>
              <div class="flex-1"></div>
              <a-select
                :model-value="news.source"
                :style="{ width: '150px' }"
                placeholder="全部来源"
                allow-clear
                @change="onSourceChange"
              >
                <a-option v-for="s in news.categories.sources" :key="s" :value="s">{{ s }}</a-option>
              </a-select>
              <a-input-search
                :style="{ width: '200px' }"
                placeholder="搜索资讯关键词"
                allow-clear
                search-button
                @search="(v: string) => news.setKeyword(v)"
              />
            </div>

            <a-spin :loading="news.loading" class="w-full">
              <div class="mt-4 flex flex-col gap-3">
                <div
                  v-for="n in news.items"
                  :key="n.id"
                  class="mw-card p-4 flex gap-4 cursor-pointer transition-shadow hover:shadow-sm"
                  :class="news.isSelected(n.id)
                    ? 'border-[color:var(--mw-primary-mid)] ring-1 ring-[color:var(--mw-primary-soft)]'
                    : ''"
                  @click="toggleNews(n.id)"
                >
                  <!-- 不能用 <a-checkbox>：它渲染成 <label>，嵌在卡片 <label> 里会触发 HTML
                       「label 不可嵌套」规则，导致点方框无效。这里用纯展示的勾选图标 +
                       外层 div 统一接管点击，避免双重触发。 -->
                  <span
                    class="mt-1 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[3px] border transition-colors"
                    :class="news.isSelected(n.id)
                      ? 'border-[color:var(--mw-primary)] bg-[color:var(--mw-primary)] text-white'
                      : 'border-[color:var(--mw-border)] bg-white text-transparent'"
                    aria-hidden="true"
                  >
                    <icon-check :size="11" />
                  </span>
                  <ThumbBox :seed="n.id" :width="86" :height="64" />
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 text-[12px] text-[var(--mw-text3)]">
                      <span :class="CAT_CLASS[n.category] || 'mw-tag mw-tag-gray'">{{ n.category }}</span>
                      <span>{{ n.source }} · {{ fmtTime(n.publishedAt) }}</span>
                      <span class="flex-1"></span>
                      <a
                        v-if="n.contentUrl"
                        class="mw-link whitespace-nowrap"
                        :href="n.contentUrl"
                        target="_blank"
                        rel="noreferrer"
                        @click.stop
                        >查看来源 <icon-right :size="12"
                      /></a>
                    </div>
                    <div class="mt-1.5 text-[15px] font-semibold leading-6">{{ n.title }}</div>
                    <div v-if="n.summary" class="mt-1 text-[13px] text-[var(--mw-text3)] leading-5 line-clamp-2">
                      {{ n.summary }}
                    </div>
                  </div>
                </div>

                <a-empty v-if="!news.loading && !news.items.length" description="暂无资讯，点击右上角采集最新资讯" />
              </div>
            </a-spin>

            <div v-if="news.total > news.pageSize" class="mt-4 flex justify-center">
              <a-pagination
                :total="news.total"
                :current="news.page"
                :page-size="news.pageSize"
                show-total
                @change="(p: number) => news.setPage(p)"
              />
            </div>

            <!-- 已选资料 / 生成设置 -->
            <div class="mw-card p-5 mt-4">
              <div class="flex items-center justify-between">
                <div class="text-[15px] font-semibold">
                  已选 {{ news.selectedIds.length }} 条资料
                  <span class="mw-subtle font-normal">（每次 1~10 条，共 {{ news.total }} 条可选）</span>
                </div>
                <a-button v-if="news.selectedIds.length" size="mini" type="text" @click="news.clearSelect()"
                  >清空</a-button
                >
              </div>

              <div class="mt-3 flex flex-col gap-1">
                <div class="mw-form-row">
                  <div class="mw-form-label">目标角色 / 人物</div>
                  <a-select
                    v-model="targetPersonas"
                    :style="{ width: '360px' }"
                    placeholder="选择人物（可多选）"
                    multiple
                    :max-tag-count="3"
                  >
                    <a-option v-for="p in personas.enabled" :key="p.id" :value="p.id">
                      {{ p.name }}
                      <span class="mw-subtle ml-1">{{ p.ipProfile.role }}</span>
                    </a-option>
                  </a-select>
                  <span class="mw-subtle">已选 {{ targetPersonas.length }} 人</span>
                </div>
                <div class="mw-form-row">
                  <div class="mw-form-label">生成数量</div>
                  <a-input-number v-model="genCount" :min="1" :max="10" :style="{ width: '120px' }" mode="button" />
                  <div class="mw-subtle leading-4 whitespace-nowrap">
                    本批合计<br /><b class="text-[13px] text-[var(--mw-text)]">{{ batchExpected }} 条选题</b>
                  </div>
                </div>
                <div class="mw-form-row">
                  <div class="mw-form-label">选题方法</div>
                  <a-select v-model="templateId" :style="{ width: '220px' }" placeholder="默认提示词" allow-clear>
                    <a-option v-for="t in topics.templates" :key="t.id" :value="t.id">{{ t.name }}</a-option>
                  </a-select>
                  <a-button type="text" class="!text-[color:var(--mw-primary)]" @click="openTemplate()">
                    <template #icon><icon-plus /></template>新增
                  </a-button>
                  <a-button
                    type="text"
                    class="!text-[color:var(--mw-primary)]"
                    :disabled="!templateId"
                    @click="openTemplate(currentTemplate)"
                  >
                    <template #icon><icon-edit /></template>编辑
                  </a-button>
                </div>
              </div>

              <div class="mt-4 flex flex-col items-center gap-2">
                <a-button type="primary" long size="large" :loading="topics.generating" @click="onGenerate">
                  <template #icon><icon-thunderbolt /></template>人工生成候选选题
                </a-button>
                <div class="mw-subtle flex items-center gap-1">
                  <icon-info-circle :size="13" />仅点击后生成；候选需人工筛选并分配人物后才会送入文案工坊。
                </div>
              </div>
            </div>
          </div>

          <!-- 右列：候选选题 -->
          <div class="w-[380px] flex-shrink-0 mw-card p-5">
            <div class="flex items-center justify-between">
              <div class="text-[16px] font-semibold">
                候选选题
                <span class="mw-subtle font-normal">{{ topics.total }} 条<template v-if="topics.batch"> · 本批 {{ topics.batch.produced }}/{{ topics.batch.expected }}</template></span>
              </div>
              <a-button size="mini" type="text" :loading="topics.loading" @click="reloadCandidates">
                <template #icon><icon-refresh /></template>
              </a-button>
            </div>
            <div class="mw-subtle mt-0.5">勾选后分配人物，再送入文案工坊。</div>

            <a-spin :loading="topics.loading" class="w-full">
              <div class="mt-3 flex flex-col gap-3">
                <label
                  v-for="c in topics.items"
                  :key="c.id"
                  class="p-3.5 rounded-[10px] border cursor-pointer transition-colors"
                  :class="topics.checkedIds.includes(c.id)
                    ? 'border-[color:var(--mw-primary-mid)] bg-[color:var(--mw-primary-faint)]'
                    : 'border-[var(--mw-border)] hover:border-[color:var(--mw-primary-soft)]'"
                >
                  <div class="flex gap-3">
                    <a-checkbox
                      :model-value="topics.checkedIds.includes(c.id)"
                      @change="() => topics.toggleCheck(c.id)"
                      @click.prevent
                    />
                    <ThumbBox :seed="c.id" :width="52" :height="52" />
                    <div class="flex-1 min-w-0">
                      <div class="text-[14px] font-medium leading-5">{{ c.title }}</div>
                      <div v-if="c.direction" class="mt-2 flex items-start gap-2 text-[12px]">
                        <span class="text-[var(--mw-text3)] whitespace-nowrap">方向</span>
                        <span class="mw-tag mw-tag-gray">{{ c.direction }}</span>
                      </div>
                      <div v-if="c.hook" class="mt-1 text-[12px] text-[var(--mw-text3)] leading-4">钩子：{{ c.hook }}</div>
                      <div class="mt-1.5 flex items-center gap-2 text-[12px]">
                        <span class="text-[var(--mw-text3)] whitespace-nowrap">分配给</span>
                        <a-select
                          :model-value="currentPersonas(c)"
                          size="mini"
                          :style="{ width: '180px' }"
                          placeholder="选择人物"
                          multiple
                          :max-tag-count="1"
                          @click.stop
                          @change="(v) => onAssignChange(c.id, v)"
                        >
                          <a-option v-for="p in personas.enabled" :key="p.id" :value="p.id">{{ p.name }}</a-option>
                        </a-select>
                      </div>
                      <div v-if="!currentPersonas(c).length" class="mt-1 text-[12px] text-[var(--mw-text3)]">
                        未分配人物，不能直接送入
                      </div>
                    </div>
                  </div>
                </label>

                <a-empty v-if="!topics.loading && !topics.items.length" description="还没有候选选题" />
              </div>
            </a-spin>

            <div class="mt-4 pt-3 border-t border-[var(--mw-border)] flex items-center gap-3">
              <div class="text-[13px]">
                <b>{{ topics.checkedIds.length }}</b> 条 · 已分配 <b>{{ topics.assignedChecked.length }}</b> 条
              </div>
              <div class="flex-1"></div>
              <a-button type="primary" :disabled="!topics.checkedIds.length" @click="onSendToCopy">
                送入文案工坊<icon-right class="ml-1" />
              </a-button>
            </div>
            <div class="mw-subtle mt-2 flex items-center gap-1">
              <icon-info-circle :size="13" />进入文案工坊后继续编辑与送审。
            </div>
          </div>
        </div>
      </a-tab-pane>

      <!-- ============ 对标账号视频 ============ -->
      <a-tab-pane key="bench" title="对标账号视频">
        <div class="mt-1 flex flex-col gap-4">
          <!-- 账号管理条 -->
          <div class="mw-card p-5">
            <div class="flex items-center gap-3 flex-wrap">
              <span class="text-[15px] font-semibold">对标账号</span>
              <span class="mw-tag mw-tag-gray">{{ bench.accounts.length }} 个</span>
              <a-button size="small" type="primary" @click="openAddAccount">
                <template #icon><icon-plus /></template>添加账号链接
              </a-button>
              <div class="flex-1"></div>
              <a-tooltip v-if="bench.quota" :content="quotaTip">
                <span class="mw-subtle cursor-help">
                  <icon-info-circle :size="13" class="mr-1" />预计日调用
                  <b class="text-[var(--mw-text)]">{{ bench.quota.dailyCalls }}</b> 次 · 估算费用
                  <b class="text-[var(--mw-text)]">¥{{ bench.quota.estimatedCost.toFixed(2) }}</b>/天
                </span>
              </a-tooltip>
            </div>

            <div v-if="bench.accounts.length" class="mt-3 grid grid-cols-2 gap-3">
              <div
                v-for="a in bench.accounts"
                :key="a.id"
                class="p-3 rounded-[10px] border flex items-center gap-3"
                :class="isAbnormal(a)
                  ? 'border-[color:var(--mw-danger,#c03e35)] bg-[#fdeeee]'
                  : 'border-[var(--mw-border-light)] bg-[#fafbfc]'"
              >
                <a-avatar :size="36" :style="{ backgroundColor: '#dbe6f6', color: '#1d4ed8', flexShrink: 0 }">
                  {{ (a.nickname || '?').slice(0, 1) }}
                </a-avatar>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="text-[13.5px] font-semibold truncate">{{ a.nickname }}</span>
                    <a-tag v-if="a.monitorStatus === 'paused'" size="small" color="gray">已暂停</a-tag>
                    <a-tag v-else-if="isAbnormal(a)" size="small" color="red">异常</a-tag>
                    <a-tag v-else size="small" color="green">监控中</a-tag>
                  </div>
                  <div class="mt-0.5 text-[12px] text-[var(--mw-text3)] truncate">
                    粉丝 {{ fmtNum(a.fansCount) }} · 每 {{ a.monitorIntervalHours }}h ·
                    下次 {{ fmtTime(a.nextCheckAt) }}
                  </div>
                  <div v-if="a.lastError" class="mt-0.5 text-[12px] text-[#c03e35] truncate">
                    连续失败 {{ a.consecutiveFailures }} 次：{{ a.lastError }}
                  </div>
                </div>
                <div class="flex items-center gap-1 flex-shrink-0">
                  <a-tooltip content="立即检查一次">
                    <a-button size="mini" type="text" @click="onFetchNow(a)">
                      <template #icon><icon-refresh /></template>
                    </a-button>
                  </a-tooltip>
                  <a-tooltip :content="a.monitorStatus === 'paused' ? '恢复监控' : '暂停监控'">
                    <a-button size="mini" type="text" @click="onToggleMonitor(a)">
                      <template #icon><icon-pause v-if="a.monitorStatus !== 'paused'" /><icon-play-arrow v-else /></template>
                    </a-button>
                  </a-tooltip>
                  <a-popconfirm content="移除后不再监控，历史视频仍保留。确认移除？" @ok="() => bench.remove(a.id)">
                    <a-button size="mini" type="text" status="danger">
                      <template #icon><icon-delete /></template>
                    </a-button>
                  </a-popconfirm>
                </div>
              </div>
            </div>
            <div v-else class="mt-3 p-4 rounded-[8px] bg-[#f7f8fa] text-[13px] text-[var(--mw-text2)]">
              还没有对标账号。粘贴抖音主页链接即可添加，添加后自动回填最近一页作品并开始按周期检查。
            </div>
          </div>

          <!-- 告警 -->
          <div class="mw-card p-5">
            <div class="flex items-center gap-3">
              <span class="text-[15px] font-semibold">监控告警</span>
              <a-badge :count="bench.unread" :max-count="99">
                <span class="mw-tag mw-tag-yellow">未读</span>
              </a-badge>
              <div class="flex-1"></div>
              <a-button size="small" type="text" :disabled="!bench.unread" @click="onReadAll">全部标为已读</a-button>
              <a-button size="small" type="text" @click="refreshAlerts">
                <template #icon><icon-refresh /></template>
              </a-button>
            </div>

            <div v-if="bench.alerts.length" class="mt-3 flex flex-col gap-2">
              <div
                v-for="al in bench.alerts"
                :key="al.id"
                class="flex items-center gap-3 p-3 rounded-[8px] border"
                :class="al.isRead ? 'border-[var(--mw-border-light)] bg-white' : 'border-[#f3d9a4] bg-[#fffaf0]'"
              >
                <span class="mw-tag" :class="al.type === 'hot' ? 'mw-tag-red' : 'mw-tag-blue'">
                  {{ al.type === 'hot' ? '爆款' : '新发布' }}
                </span>
                <div class="flex-1 min-w-0">
                  <div class="text-[13.5px] truncate">{{ al.payload?.title || '（无标题）' }}</div>
                  <div class="mt-0.5 text-[12px] text-[var(--mw-text3)]">
                    {{ al.payload?.nickname || '—' }} · {{ fmtTime(al.createdAt) }}
                    <template v-if="al.type === 'hot' && al.payload?.threshold">
                      · 阈值 {{ fmtNum(Number(al.payload.threshold)) }}
                    </template>
                  </div>
                </div>
                <a-button v-if="!al.isRead" size="mini" type="text" @click="() => bench.markRead(al.id)">标为已读</a-button>
              </div>
            </div>
            <div v-else class="mt-2 mw-subtle">暂无告警。账号按周期检查时，出现新作品或爆款会自动产生告警。</div>
          </div>

          <!-- 视频筛选 -->
          <div class="flex items-center gap-2 flex-wrap">
            <a-select
              :model-value="bench.videoFilter.accountId || ''"
              :style="{ width: '200px' }"
              placeholder="全部账号"
              allow-clear
              @change="onAccountFilter"
            >
              <a-option value="">全部账号</a-option>
              <a-option v-for="a in bench.accounts" :key="a.id" :value="a.id">{{ a.nickname }}</a-option>
            </a-select>
            <a-select
              :model-value="bench.videoFilter.extractStatus || ''"
              :style="{ width: '160px' }"
              placeholder="提取状态"
              allow-clear
              @change="onStatusFilter"
            >
              <a-option value="">提取状态</a-option>
              <a-option v-for="s in extractStatusOptions" :key="s.value" :value="s.value">{{ s.label }}</a-option>
            </a-select>
            <a-checkbox :model-value="!!bench.videoFilter.onlyHot" @change="onOnlyHot">只看爆款</a-checkbox>
            <a-checkbox :model-value="bench.videoFilter.origin === 'adhoc'" @change="onOnlyAdhoc"
              >只看直接提取</a-checkbox
            >
            <div class="flex-1"></div>
            <span class="mw-subtle">共 {{ bench.videoTotal }} 条</span>
            <a-button size="small" type="text" :loading="bench.videosLoading" @click="() => bench.loadVideos()">
              <template #icon><icon-refresh /></template>
            </a-button>
          </div>

          <!-- 视频网格 -->
          <a-spin :loading="bench.videosLoading" class="w-full">
            <div class="grid grid-cols-3 gap-4">
              <div
                v-for="v in bench.videos"
                :key="v.id"
                class="mw-card p-4 flex flex-col gap-3"
                :class="v.isHot ? 'border-[#f0b6b1]' : ''"
              >
                <div class="flex gap-3">
                  <img
                    v-if="v.coverUrl"
                    :src="v.coverUrl"
                    class="mw-thumb w-[104px] h-[70px] flex-shrink-0"
                    alt=""
                  />
                  <ThumbBox v-else :seed="v.videoId" :width="104" :height="70" />
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-1.5 flex-wrap">
                      <span class="mw-tag mw-tag-gray">{{ platformLabel(v.platform) }}</span>
                      <span v-if="v.isHot" class="mw-tag mw-tag-red">爆款</span>
                      <span v-if="v.isTop" class="mw-tag mw-tag-purple">置顶</span>
                      <span v-if="v.origin === 'adhoc'" class="mw-tag mw-tag-orange">直接提取</span>
                      <span :class="EXTRACT_TAG[v.extractStatus]">{{ EXTRACT_LABEL[v.extractStatus] }}</span>
                    </div>
                    <div class="mt-1.5 text-[14px] font-semibold leading-5 line-clamp-2">{{ v.title || '（无标题）' }}</div>
                    <div class="mt-1 text-[12px] text-[var(--mw-text3)] truncate">
                      {{ v.authorNickname || v.accountNickname || '—' }} · {{ fmtTime(v.publishedAt) }}
                      <template v-if="v.duration"> · {{ fmtDuration(v.duration) }}</template>
                    </div>
                  </div>
                </div>

                <div class="flex items-center gap-3 text-[12px] text-[var(--mw-text3)]">
                  <span>赞 {{ fmtNum(v.diggCount) }}</span>
                  <span>评 {{ fmtNum(v.commentCount) }}</span>
                  <span>转 {{ fmtNum(v.shareCount) }}</span>
                  <span class="flex-1"></span>
                  <span class="text-[var(--mw-text2)]">互动 {{ fmtNum(v.interactTotal) }}</span>
                </div>
                <div v-if="v.extractStatus === 'failed' && v.extractError" class="text-[12px] text-[#c03e35] leading-4">
                  {{ v.extractError }}
                </div>
                <div v-else-if="v.extractStatus === 'uncertain'" class="text-[12px] text-[#a26a08] leading-4">
                  结果不确定，需人工确认后重试（避免重复计费）。
                </div>

                <div class="flex items-center gap-2 pt-1 border-t border-[var(--mw-border-light)]">
                  <a-button
                    v-if="v.extractStatus === 'done'"
                    size="mini"
                    type="text"
                    class="!text-[color:var(--mw-primary)]"
                    @click="openScript(v)"
                  >
                    <template #icon><icon-file /></template>查看文案
                  </a-button>
                  <a-button
                    v-else
                    size="mini"
                    type="text"
                    :loading="EXTRACTING.includes(v.extractStatus)"
                    @click="onExtract(v)"
                  >
                    <template #icon><icon-download /></template>
                    {{ v.extractStatus === 'none' ? '提取文案' : v.extractStatus === 'failed' || v.extractStatus === 'uncertain' ? '重试提取' : '提取中' }}
                  </a-button>
                  <div class="flex-1"></div>
                  <a-button
                    size="mini"
                    type="outline"
                    :disabled="v.extractStatus !== 'done'"
                    @click="openSendCopy(v)"
                  >
                    送文案工坊<icon-right class="ml-0.5" :size="12" />
                  </a-button>
                </div>
                <div v-if="v.sentCopyCount" class="mw-subtle">已送工坊 {{ v.sentCopyCount }} 次</div>
              </div>
            </div>
            <a-empty v-if="!bench.videosLoading && !bench.videos.length" description="暂无视频，添加一个对标账号吧" />
          </a-spin>

          <div v-if="bench.videoTotal > bench.videoPageSize" class="flex justify-center">
            <a-pagination
              :total="bench.videoTotal"
              :current="bench.videoPage"
              :page-size="bench.videoPageSize"
              show-total
              @change="(p: number) => bench.setVideoPage(p)"
            />
          </div>

          <div class="mw-subtle flex items-center gap-1">
            <icon-info-circle :size="13" />
            <template v-if="bench.showPlayCount">播放量口径：接口可返回播放数。</template>
            <template v-else>非本人视频的播放量接口通常返回 0，爆款判定以「赞+评+转」互动合计为准。</template>
          </div>
        </div>
      </a-tab-pane>
    </a-tabs>

    <!-- ============ 弹窗：添加账号 ============ -->
    <a-modal v-model:visible="accModal.visible" title="添加对标账号" :mask-closable="false" @cancel="resetAccModal">
      <template #footer>
        <a-button @click="resetAccModal">取消</a-button>
        <a-button type="primary" :loading="accModal.submitting" :disabled="!accModal.previewed" @click="onAddAccount">
          添加并回填
        </a-button>
      </template>
      <a-form :model="accModal" layout="vertical">
        <a-form-item label="账号主页链接" required>
          <a-input
            v-model="accModal.url"
            placeholder="https://www.douyin.com/user/MS4wLjABAAAA..."
            allow-clear
            @change="accModal.previewed = null"
          />
          <template #extra>
            <span class="mw-subtle">支持抖音主页链接；短链会自动还原，非白名单域名将被拒绝。</span>
          </template>
        </a-form-item>
        <a-form-item>
          <a-button type="outline" :loading="accModal.previewing" :disabled="!accModal.url" @click="onPreviewAccount">
            <template #icon><icon-search /></template>解析预览
          </a-button>
        </a-form-item>
        <div v-if="accModal.previewed" class="p-3 rounded-[8px] bg-[#f7f8fa] text-[13px]">
          <div><b>{{ accModal.previewed.nickname }}</b> · 粉丝 {{ fmtNum(accModal.previewed.fansCount) }}</div>
          <div v-if="accModal.previewed.exists" class="mt-1 text-[#a26a08]">该账号已在监控列表中，不能重复添加。</div>
        </div>
        <a-form-item label="检查周期" class="!mt-3">
          <div class="flex flex-col gap-2">
            <a-radio-group v-model="accModal.intervalHours" type="button" size="small">
              <a-radio :value="1">每 1 小时</a-radio>
              <a-radio :value="6">每 6 小时</a-radio>
              <a-radio :value="12">每 12 小时</a-radio>
              <a-radio :value="24">每天</a-radio>
              <a-radio :value="48">每 2 天</a-radio>
            </a-radio-group>
            <div class="flex items-center gap-2">
              <span class="mw-subtle whitespace-nowrap">自定义（小时）</span>
              <a-input-number
                v-model="accModal.intervalHours"
                :min="1"
                :max="720"
                :style="{ width: '150px' }"
                mode="button"
              />
              <span class="mw-subtle">{{ intervalHint }}</span>
            </div>
          </div>
          <template #extra
            ><span class="mw-subtle">最短 1 小时；周期越短，日调用量与费用越高。</span></template
          >
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- ============ 弹窗：视频直接提取改写 ============ -->
    <a-modal
      v-model:visible="linkModal.visible"
      title="视频直接提取改写"
      :mask-closable="false"
      @cancel="linkModal.url = ''"
    >
      <template #footer>
        <a-button @click="linkModal.visible = false">取消</a-button>
        <a-button type="primary" :loading="linkModal.submitting" @click="onParseLink">解析并提取</a-button>
      </template>
      <a-form :model="linkModal" layout="vertical">
        <a-form-item label="视频分享链接" required>
          <a-input v-model="linkModal.url" placeholder="https://www.douyin.com/video/7..." allow-clear />
          <template #extra>
            <span class="mw-subtle">无需先建立监控关系；仅支持白名单域名（抖音等），短链会自动还原。</span>
          </template>
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- ============ 弹窗：查看文案 ============ -->
    <a-modal v-model:visible="scriptModal.visible" :title="`文案提取结果 · ${scriptModal.title}`" width="720px" footer>
      <template #footer>
        <a-button type="primary" @click="scriptModal.visible = false">关闭</a-button>
      </template>
      <a-spin :loading="scriptModal.loading">
        <div v-if="scriptModal.data">
          <div class="mw-subtle">
            引擎 {{ scriptModal.data.engine || '—' }} · 时长
            {{ scriptModal.data.duration ? fmtDuration(scriptModal.data.duration) : '—' }}
            <template v-if="scriptModal.data.updatedAt"> · {{ fmtTime(scriptModal.data.updatedAt) }}</template>
          </div>
          <div class="mt-3 p-3.5 rounded-[8px] bg-[#fafbfc] text-[13.5px] leading-6 whitespace-pre-wrap">
            {{ scriptModal.data.text }}
          </div>
          <div class="mt-4 text-[14px] font-semibold">句级时间戳</div>
          <div class="mt-2 max-h-[260px] overflow-auto">
            <div
              v-for="(s, i) in scriptModal.data.sentences"
              :key="i"
              class="flex gap-3 py-1.5 text-[13px] border-b border-[var(--mw-border-light)]"
            >
              <span class="text-[var(--mw-text3)] font-mono w-[92px] flex-shrink-0">
                {{ mmss(s.beginTime) }} - {{ mmss(s.endTime) }}
              </span>
              <span class="flex-1">{{ s.text }}</span>
            </div>
          </div>
        </div>
      </a-spin>
    </a-modal>

    <!-- ============ 弹窗：送文案工坊 ============ -->
    <a-modal v-model:visible="sendModal.visible" title="送入文案工坊" :mask-closable="false">
      <template #footer>
        <a-button @click="sendModal.visible = false">取消</a-button>
        <a-button type="primary" :loading="sendModal.submitting" @click="onSendVideoToCopy">确认送入</a-button>
      </template>
      <div class="text-[13.5px] mb-3">{{ sendModal.title }}</div>
      <a-form :model="sendModal" layout="vertical">
        <a-form-item label="目标人物" required>
          <a-select v-model="sendModal.personaIds" multiple placeholder="选择人物（可多选）">
            <a-option v-for="p in personas.enabled" :key="p.id" :value="p.id">
              {{ p.name }} <span class="mw-subtle ml-1">{{ p.ipProfile.role }}</span>
            </a-option>
          </a-select>
          <template #extra><span class="mw-subtle">将按「视频 × 人物」展开创建文案草稿，并带上提取全文与句级时间戳。</span></template>
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- ============ 弹窗：提示词模板 ============ -->
    <a-modal
      v-model:visible="tplModal.visible"
      :title="tplModal.id ? '编辑提示词模板' : '新增提示词模板'"
      width="680px"
      :mask-closable="false"
    >
      <template #footer>
        <a-button @click="tplModal.visible = false">取消</a-button>
        <a-button type="primary" :loading="tplModal.submitting" @click="onSaveTemplate">保存</a-button>
      </template>
      <a-form :model="tplModal" layout="vertical">
        <a-form-item label="名称" required>
          <a-input v-model="tplModal.name" placeholder="如：市场解读 / 投教科普" />
        </a-form-item>
        <a-form-item label="提示词内容" required>
          <a-textarea v-model="tplModal.content" :auto-size="{ minRows: 8, maxRows: 16 }" />
          <template #extra>
            <span class="mw-subtle">
              可用占位符：{'{'}role{'}'} {'{'}service_scope{'}'} {'{'}target_audience{'}'} {'{'}expression_style{'}'}
              {'{'}forbidden_claims{'}'} {'{'}name{'}'}。资讯内容会自动追加在提示词之后。
            </span>
          </template>
        </a-form-item>
        <a-form-item>
          <a-checkbox v-model="tplModal.isDefault">设为默认</a-checkbox>
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Message, Modal } from '@arco-design/web-vue'
import PageHead from '@/components/PageHead.vue'
import ThumbBox from '@/components/ThumbBox.vue'
import { ApiError } from '@/api/client'
import type { Account, AccountPreview, BenchVideo, ExtractStatus, VideoScript } from '@/api/benchmark'
import type { TopicTemplate } from '@/api/topics'
import { CAT_CLASS, useNewsStore } from '@/stores/news'
import { useTopicStore } from '@/stores/topics'
import { usePersonaStore } from '@/stores/personas'
import { EXTRACTING, EXTRACT_LABEL, EXTRACT_TAG, useBenchmarkStore } from '@/stores/benchmark'

const router = useRouter()
const tab = ref('news')

const news = useNewsStore()
const topics = useTopicStore()
const personas = usePersonaStore()
const bench = useBenchmarkStore()

const todayText = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })

/* ── 资讯 → 选题 ─────────────────────────── */
const targetPersonas = ref<string[]>([])
const genCount = ref(3)
const templateId = ref<string | undefined>(undefined)

const currentTemplate = computed(() => topics.templates.find((t) => t.id === templateId.value))
const batchExpected = computed(
  () => Math.max(news.selectedIds.length, 1) * Math.max(targetPersonas.value.length, 1) * genCount.value,
)

function toggleNews(id: string) {
  if (!news.toggleSelect(id)) Message.warning('每次最多选择 10 条资讯')
}

/** Arco 的 change 回调入参是联合类型，统一在入口处收敛 */
function onSourceChange(v: unknown) {
  news.setSource(v == null ? '' : String(v))
}

async function onRefreshNews() {
  try {
    const res = await news.refresh()
    if (res.status === 'done') Message.success(`采集完成：抓取 ${res.fetched} 条，新增 ${res.inserted} 条`)
    else Message.info(res.message || '采集已在后台继续，稍后刷新列表')
  } catch (e) {
    Message.error(errOf(e))
  }
}

async function onGenerate() {
  if (!news.selectedIds.length) return Message.warning('请先勾选 1~10 条资讯')
  if (!targetPersonas.value.length) return Message.warning('请至少选择 1 个人物')
  try {
    const b = await topics.generate({
      newsIds: news.selectedIds,
      personaIds: targetPersonas.value,
      countPer: genCount.value,
      templateId: templateId.value,
    })
    if (b.status === 'failed') Message.error(b.error || '生成失败')
    else Message.success(`已生成 ${b.produced} 条候选选题`)
  } catch (e) {
    Message.error(errOf(e))
  }
}

/**
 * 当前生效的人物：本地临时选择优先，回落选题自身的 personaIds。
 *
 * 下拉、卡片提示、送入前校验三处必须用同一个口径，否则会出现
 * 「下拉已选好人物、卡片却提示未分配」这种自相矛盾的界面。
 */
function currentPersonas(c: { id: string; personaIds?: string[] }): string[] {
  return topics.assignment[c.id] ?? c.personaIds ?? []
}

function onAssignChange(topicId: string, v: unknown) {
  onAssign(topicId, Array.isArray(v) ? (v as string[]) : [])
}

function onAssign(topicId: string, personaIds: string[]) {
  topics.setAssignment(topicId, personaIds)
  void topics
    .assign(topicId, personaIds)
    .then(() => Message.success('已分配人物'))
    .catch((e) => Message.error(errOf(e)))
}

async function onSendToCopy() {
  const ids = topics.checkedIds
  if (!ids.length) return Message.warning('请先勾选候选选题')
  const unassigned = topics.checkedItems.filter((t) => !currentPersonas(t).length)
  if (unassigned.length) return Message.warning(`有 ${unassigned.length} 条候选尚未分配人物`)
  try {
    const created = await topics.send(ids)
    Message.success(`已送入文案工坊，创建 ${created.created} 条草稿`)
    // 直接带 ids 跳到文案工坊，避免用户再自己找刚生成的文案
    const idsParam = created.copyIds?.length ? `?ids=${created.copyIds.join(',')}` : ''
    void router.push(`/copy${idsParam}`)
  } catch (e) {
    Message.error(errOf(e))
  }
}

function reloadCandidates() {
  void topics.load()
}

/* ── 提示词模板 ─────────────────────────── */
const tplModal = reactive({
  visible: false,
  id: '' as string | undefined,
  name: '',
  content: '',
  isDefault: false,
  submitting: false,
})

function openTemplate(t?: TopicTemplate) {
  tplModal.id = t?.id
  tplModal.name = t?.name ?? ''
  tplModal.content = t?.content ?? ''
  tplModal.isDefault = t?.isDefault ?? false
  tplModal.visible = true
}

async function onSaveTemplate() {
  if (!tplModal.name.trim() || !tplModal.content.trim()) return Message.warning('名称与内容必填')
  tplModal.submitting = true
  try {
    await topics.saveTemplate({
      id: tplModal.id,
      name: tplModal.name.trim(),
      content: tplModal.content,
      isDefault: tplModal.isDefault,
    })
    Message.success('模板已保存')
    tplModal.visible = false
  } catch (e) {
    Message.error(errOf(e))
  } finally {
    tplModal.submitting = false
  }
}

/* ── 对标账号 ───────────────────────────── */
const accModal = reactive({
  visible: false,
  url: '',
  intervalHours: 2,
  previewing: false,
  submitting: false,
  previewed: null as AccountPreview | null,
})

/** 周期换算提示：把小时数翻译成「每天几次 / 每几天一次」 */
const intervalHint = computed(() => {
  const h = Number(accModal.intervalHours)
  if (!h || h < 1) return ''
  if (h % 24 === 0) {
    const days = h / 24
    return days === 1 ? '= 每天 1 次' : `= 每 ${days} 天 1 次`
  }
  return `= 每天约 ${(24 / h).toFixed(1)} 次`
})

function openAddAccount() {
  accModal.visible = true
}
function resetAccModal() {
  accModal.visible = false
  accModal.url = ''
  accModal.intervalHours = 2
  accModal.previewed = null
}

async function onPreviewAccount() {
  accModal.previewing = true
  try {
    accModal.previewed = await bench.preview(accModal.url.trim())
  } catch (e) {
    accModal.previewed = null
    Message.error(errOf(e))
  } finally {
    accModal.previewing = false
  }
}

async function onAddAccount() {
  if (accModal.previewed?.exists) return Message.warning('该账号已在监控列表中')
  accModal.submitting = true
  try {
    const a = await bench.add(accModal.url.trim(), accModal.intervalHours)
    Message.success(`已添加「${a.nickname}」，正在后台回填最近作品`)
    resetAccModal()
    void bench.loadVideos()
  } catch (e) {
    Message.error(errOf(e))
  } finally {
    accModal.submitting = false
  }
}

function isAbnormal(a: Account) {
  return a.monitorStatus === 'on' && (a.consecutiveFailures > 0 || !!a.lastError)
}

const quotaTip = computed(() => {
  const q = bench.quota
  if (!q) return ''
  const p = q.unitPrice
  return `${q.accounts} 个账号 · 单次作品列表 ¥${p.postList}、用户信息 ¥${p.userInfo}、视频详情 ¥${p.videoDetail}`
})

async function onFetchNow(a: Account) {
  try {
    await bench.fetchNow(a.id)
    Message.success(`已触发「${a.nickname}」立即检查`)
  } catch (e) {
    Message.error(errOf(e))
  }
}

async function onToggleMonitor(a: Account) {
  try {
    await bench.update(a.id, { monitorStatus: a.monitorStatus === 'paused' ? 'on' : 'paused' })
  } catch (e) {
    Message.error(errOf(e))
  }
}

/* ── 视频：提取 / 文案 / 送工坊 ─────────── */
const extractStatusOptions: { value: ExtractStatus; label: string }[] = (
  ['none', 'pending', 'submitting', 'running', 'done', 'failed', 'uncertain'] as ExtractStatus[]
).map((s) => ({ value: s, label: EXTRACT_LABEL[s] }))

function onAccountFilter(v: unknown) {
  void bench.loadVideos({ accountId: v ? String(v) : undefined })
}
function onStatusFilter(v: unknown) {
  void bench.loadVideos({ extractStatus: v ? (String(v) as ExtractStatus) : undefined })
}
function onOnlyHot(v: unknown) {
  void bench.loadVideos({ onlyHot: v ? true : undefined })
}
function onOnlyAdhoc(v: unknown) {
  void bench.loadVideos({ origin: v ? 'adhoc' : undefined })
}

async function onExtract(v: BenchVideo) {
  // P1-3①：uncertain 意味着上一次提取可能已提交但结果未知，重试会再次计费，必须先人工确认
  if (v.extractStatus === 'uncertain') {
    const okConfirm = await new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: '确认重新提取？',
        content: '上一次提取结果不确定，可能已产生费用。确认后将以当前视频状态重新提交一次提取，可能重复计费。',
        okText: '确认重试',
        cancelText: '取消',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      })
    })
    if (!okConfirm) return
  }
  try {
    await bench.extract(v.id, v.extractStatus === 'uncertain')
    Message.info('已加入提取队列，完成后可直接查看文案')
  } catch (e) {
    Message.error(errOf(e))
  }
}

const scriptModal = reactive({
  visible: false,
  loading: false,
  title: '',
  data: null as VideoScript | null,
})

async function openScript(v: BenchVideo) {
  scriptModal.visible = true
  scriptModal.loading = true
  scriptModal.title = v.title || '（无标题）'
  scriptModal.data = null
  try {
    scriptModal.data = await bench.getScript(v.id)
  } catch (e) {
    Message.error(errOf(e))
    scriptModal.visible = false
  } finally {
    scriptModal.loading = false
  }
}

const sendModal = reactive({
  visible: false,
  videoId: '',
  title: '',
  personaIds: [] as string[],
  submitting: false,
})

function openSendCopy(v: BenchVideo) {
  sendModal.videoId = v.id
  sendModal.title = v.title || '（无标题）'
  sendModal.personaIds = []
  sendModal.visible = true
}

async function onSendVideoToCopy() {
  if (!sendModal.personaIds.length) return Message.warning('请至少选择 1 个人物')
  sendModal.submitting = true
  try {
    const res = await bench.sendToCopy(sendModal.videoId, sendModal.personaIds)
    Message.success(`已创建 ${res.copyIds.length} 条文案草稿`)
    sendModal.visible = false
    const idsParam = res.copyIds?.length ? `?ids=${res.copyIds.join(',')}` : ''
    void router.push(`/copy${idsParam}`)
  } catch (e) {
    Message.error(errOf(e))
  } finally {
    sendModal.submitting = false
  }
}

/* ── 直接提取链接 ───────────────────────── */
const linkModal = reactive({ visible: false, url: '', submitting: false })

function openExtractLink() {
  linkModal.visible = true
}

async function onParseLink() {
  if (!linkModal.url.trim()) return Message.warning('请粘贴视频分享链接')
  linkModal.submitting = true
  try {
    const v = await bench.parseLink(linkModal.url.trim())
    Message.success(`已写入「${v.title || '（无标题）'}」并开始提取文案`)
    linkModal.visible = false
    linkModal.url = ''
  } catch (e) {
    if (e instanceof ApiError && e.code === 'domain_not_allowed') {
      Message.error('该链接不在允许的白名单域名内，请检查后重试')
    } else {
      Message.error(errOf(e))
    }
  } finally {
    linkModal.submitting = false
  }
}

/* ── 告警 ───────────────────────────────── */
function refreshAlerts() {
  void bench.loadAlerts()
  void bench.loadUnread()
}
async function onReadAll() {
  try {
    await bench.readAll()
  } catch (e) {
    Message.error(errOf(e))
  }
}

/* ── 工具 ───────────────────────────────── */
function errOf(e: unknown): string {
  return e instanceof Error ? e.message : '操作失败'
}
function fmtNum(n: number): string {
  const v = Number(n || 0)
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}亿`
  if (v >= 10_000) return `${(v / 10_000).toFixed(1)}w`
  return String(v)
}
function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const pad = (n: number) => String(n).padStart(2, '0')
  return s >= 3600 ? `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}
function mmss(ms: number): string {
  const s = Math.floor((ms || 0) / 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}
function platformLabel(p: string): string {
  return p === 'douyin' ? '抖音' : p
}

/* ── 轮询：提取中状态 + 未读告警 ────────── */
let extractTimer: number | undefined
let alertTimer: number | undefined

onMounted(() => {
  void personas.load()
  void news.loadCategories()
  void news.load()
  void topics.load()
  void topics.loadTemplates()
  void bench.loadAccounts()
  void bench.loadQuota()
  void bench.loadVideos()
  void bench.loadAlerts()
  void bench.loadUnread()

  extractTimer = window.setInterval(() => {
    if (tab.value === 'bench' && bench.hasExtracting) void bench.loadVideos()
  }, 3000)
  alertTimer = window.setInterval(() => {
    if (tab.value === 'bench') void bench.loadUnread()
  }, 30_000)
})

onUnmounted(() => {
  if (extractTimer) window.clearInterval(extractTimer)
  if (alertTimer) window.clearInterval(alertTimer)
})
</script>
