<template>
  <div class="topics-page">
    <header class="topics-toolbar">
      <h1>爆款选题</h1>
      <div class="topics-modes" role="group" aria-label="选题资料类型">
        <button type="button" :aria-pressed="tab === 'news'" :class="{ active: tab === 'news' }" @click="tab = 'news'">
          热点资讯
        </button>
        <button
          type="button"
          :aria-pressed="tab === 'bench'"
          :class="{ active: tab === 'bench' }"
          @click="tab = 'bench'"
        >
          对标账号视频
        </button>
      </div>
      <div class="topics-toolbar-actions">
        <a-button type="text" @click="methodologyVisible = true"
          ><template #icon><icon-book /></template>选题方法论</a-button
        >
        <template v-if="tab === 'news'">
          <a-input-search
            v-model="news.keyword"
            placeholder="搜索资讯关键词"
            allow-clear
            aria-label="搜索资讯关键词"
            @search="(v: string) => news.setKeyword(v)"
            @press-enter="news.setKeyword(news.keyword)"
            @clear="news.setKeyword('')"
          />
          <a-button :loading="news.refreshing" @click="onRefreshNews"
            ><template #icon><icon-refresh /></template>采集资讯</a-button
          >
        </template>
        <template v-else>
          <a-button @click="openAddAccount"
            ><template #icon><icon-plus /></template>添加账号链接</a-button
          >
          <a-button type="outline" @click="openExtractLink">视频直接提取改写<icon-right class="ml-1" /></a-button>
        </template>
      </div>
    </header>

    <section v-show="tab === 'news'" class="topics-news-layout" aria-label="热点资讯工作区">
      <div class="topics-source-column">
        <div class="topics-filters">
          <div class="topics-categories" role="group" aria-label="资讯分类">
            <button
              v-for="c in news.chips"
              :key="c.key"
              type="button"
              :aria-pressed="news.category === c.key"
              :class="{ active: news.category === c.key }"
              @click="news.setCategory(c.key)"
            >
              {{ c.label }} <span>{{ c.count }}</span>
            </button>
          </div>
          <a-select
            :model-value="news.source"
            placeholder="全部来源"
            aria-label="资讯来源"
            allow-clear
            @change="onSourceChange"
          >
            <a-option v-for="s in news.categories.sources" :key="s" :value="s">{{ s }}</a-option>
          </a-select>
        </div>
        <div class="topics-news-scroll">
          <a-spin :loading="news.loading" class="w-full">
            <div class="topics-news-list">
              <article
                v-for="n in news.items"
                :key="n.id"
                class="topics-news-row"
                :class="{ selected: news.isSelected(n.id) }"
                @click="toggleNews(n.id)"
              >
                <a-checkbox :model-value="news.isSelected(n.id)" @change="toggleNews(n.id)" @click.stop
                  ><span class="sr-only">选择资讯：{{ n.title }}</span></a-checkbox
                >
                <div class="flex-1 min-w-0">
                  <div class="topics-news-meta">
                    <span class="mw-tag mw-tag-gray">{{ n.category }}</span
                    ><span>{{ n.source }} · {{ fmtTime(n.publishedAt) }}</span>
                    <a
                      v-if="n.contentUrl"
                      :href="n.contentUrl"
                      target="_blank"
                      rel="noreferrer"
                      :aria-label="`查看来源：${n.title}`"
                      title="查看来源"
                      @click.stop
                      ><icon-export :size="15"
                    /></a>
                  </div>
                  <button type="button" class="news-title" @click.stop="openNewsDetail(n)">{{ n.title }}</button>
                  <p v-if="n.summary" class="topics-news-summary">{{ n.summary }}</p>
                </div>
              </article>
            </div>
            <a-empty v-if="!news.loading && !news.items.length" description="暂无资讯，点击右上角采集资讯" />
          </a-spin>
          <div v-if="news.total > news.pageSize" class="topics-pagination">
            <a-pagination
              :total="news.total"
              :current="news.page"
              :page-size="news.pageSize"
              size="small"
              show-total
              @change="(p: number) => news.setPage(p)"
            />
          </div>
        </div>
        <div class="topics-generation-dock">
          <div class="flex items-center gap-3 mb-3">
            <strong>已选 {{ news.selectedIds.length }} 条资料</strong>
            <button v-if="news.selectedIds.length" type="button" class="mw-link" @click="news.clearSelect()">
              清空
            </button>
            <span class="mw-subtle ml-auto">每次最多 10 条</span>
          </div>
          <div class="topics-generation-controls">
            <label
              >人物
              <a-select
                v-model="targetPersonas"
                placeholder="选择人物"
                aria-label="目标角色或人物"
                multiple
                :max-tag-count="1"
              >
                <a-option v-for="p in personas.items" :key="p.id" :value="p.id" :disabled="!p.usable"
                  >{{ p.name }} · {{ p.ipProfile.role
                  }}<span v-if="!p.usable" class="mw-subtle ml-1">不可选：{{ personas.reasonOf(p.id) }}</span></a-option
                >
              </a-select>
            </label>
            <label
              >生成数量<a-input-number v-model="genCount" :min="1" :max="10" mode="button" aria-label="生成数量"
            /></label>
            <div>
              <div class="flex items-center justify-between">
                <span>选题方法</span
                ><a-dropdown trigger="click"
                  ><a-button type="text" size="mini" aria-label="管理选题方法"><icon-more /></a-button
                  ><template #content
                    ><a-doption @click="openTemplate()">新增方法</a-doption
                    ><a-doption :disabled="!templateId" @click="openTemplate(currentTemplate)"
                      >编辑当前方法</a-doption
                    ></template
                  ></a-dropdown
                >
              </div>
              <a-select v-model="templateId" placeholder="默认提示词" aria-label="选题方法" allow-clear
                ><a-option v-for="t in topics.templates" :key="t.id" :value="t.id">{{ t.name }}</a-option></a-select
              >
            </div>
            <a-button type="outline" :loading="topics.generating" @click="onGenerate"
              ><template #icon><icon-file /></template>生成候选选题</a-button
            >
          </div>
          <p class="topics-dock-note">
            本批合计 {{ batchExpected }} 条选题 · 仅点击后生成<template v-if="news.lastRefresh">
              · 上次采集新增 {{ news.lastRefresh.inserted }} 条</template
            >
          </p>
        </div>
      </div>

      <aside class="topics-candidate-column" aria-label="候选选题">
        <div class="topics-candidate-toolbar">
          <h2>
            候选选题 <span>{{ topics.total }}</span>
          </h2>
          <a-select
            :model-value="topics.filter"
            aria-label="候选选题状态"
            @change="(v) => topics.setFilter(v as CandidateFilter)"
            ><a-option value="pending">全部待送</a-option><a-option value="candidate">待分配</a-option
            ><a-option value="assigned">已分配</a-option></a-select
          >
          <a-button type="text" :loading="topics.loading" aria-label="刷新候选选题" @click="reloadCandidates"
            ><template #icon><icon-refresh /></template
          ></a-button>
        </div>
        <div v-if="topics.batchFilter || topics.batch" class="topics-batch-state">
          <a-tag v-if="topics.batchFilter" size="small" closable @close="topics.clearBatchFilter()">仅本批</a-tag>
          <span v-if="topics.batch" class="mw-subtle"
            >本批 {{ topics.batch.produced }}/{{ topics.batch.expected }}</span
          >
        </div>
        <div class="topics-candidate-scroll">
          <a-spin :loading="topics.loading" class="w-full">
            <article
              v-for="c in topics.items"
              :key="c.id"
              class="topics-candidate-row"
              :class="{ selected: topics.checkedIds.includes(c.id) }"
              @click="topics.toggleCheck(c.id)"
            >
              <a-checkbox
                :model-value="topics.checkedIds.includes(c.id)"
                @change="() => topics.toggleCheck(c.id)"
                @click.stop
                ><span class="sr-only">勾选选题：{{ c.title }}</span></a-checkbox
              >
              <div class="flex-1 min-w-0">
                <div class="flex items-start gap-2">
                  <h3>{{ c.title }}</h3>
                  <a-button
                    type="text"
                    size="mini"
                    :aria-label="`归档选题：${c.title}`"
                    title="归档"
                    @click.stop="onArchive(c.id)"
                    ><template #icon><icon-archive /></template
                  ></a-button>
                </div>
                <div v-if="c.direction" class="topics-direction">
                  <span>方向</span><span class="mw-tag mw-tag-gray">{{ c.direction }}</span>
                </div>
                <p v-if="c.hook" class="topics-hook">钩子：{{ c.hook }}</p>
                <div class="topics-persona">
                  <span>分配给</span
                  ><a-select
                    :model-value="currentPersonas(c)"
                    placeholder="选择人物"
                    :aria-label="`为${c.title}分配人物`"
                    multiple
                    :max-tag-count="1"
                    @click.stop
                    @change="(v) => onAssignChange(c.id, v)"
                    ><a-option v-for="p in personas.items" :key="p.id" :value="p.id" :disabled="!p.usable"
                      >{{ p.name
                      }}<span v-if="!p.usable" class="mw-subtle ml-1"
                        >不可选：{{ personas.reasonOf(p.id) }}</span
                      ></a-option
                    ></a-select
                  >
                </div>
                <p v-if="!currentPersonas(c).length" class="topics-assignment-note">分配人物后可送入文案工坊</p>
                <p v-else-if="c.status === 'candidate'" class="topics-assignment-note">
                  已预填目标人物，送入时按此分配
                </p>
              </div>
            </article>
            <a-empty v-if="!topics.loading && !topics.items.length" description="还没有候选选题" />
          </a-spin>
          <div v-if="topics.total > topics.pageSize" class="topics-pagination">
            <a-pagination
              :current="topics.page"
              :page-size="topics.pageSize"
              :total="topics.total"
              size="mini"
              simple
              @change="(p: number) => topics.setPage(p)"
            />
          </div>
        </div>
        <div class="topics-send-dock">
          <div>
            <strong>已选 {{ topics.checkedIds.length }} 条</strong> · 已分配 {{ topics.assignedChecked.length }} 条
          </div>
          <a-button type="primary" long :disabled="!topics.checkedIds.length" @click="onSendToCopy"
            >送入文案工坊<template v-if="topics.checkedIds.length">（{{ topics.checkedIds.length }}）</template
            ><icon-right class="ml-2"
          /></a-button>
          <p class="topics-dock-note">人工确认并分配后，进入文案工坊编辑与送审。</p>
        </div>
      </aside>
    </section>

    <!-- ============ 对标账号视频 ============ -->
    <section v-show="tab === 'bench'" class="topics-bench">
      <div class="mt-1 flex flex-col gap-4">
        <section class="research-overview" aria-label="真实对标数据概览">
          <div class="research-overview-head">
            <div>
              <span class="research-eyebrow">BENCHMARK RESEARCH</span>
              <h2>从真实作品，找到值得做的选题。</h2>
              <p>先验证表现，再拆解表达，让内容创作有据可依。</p>
            </div>
            <span class="research-source-badge" :class="{ 'is-demo': overview?.provider.mode !== 'live' }"
              ><i />{{
                overview?.provider.mode === 'live'
                  ? 'TikHub 真实数据'
                  : overview?.provider.mode === 'demo'
                    ? '演示数据模式'
                    : '数据源待配置'
              }}</span
            >
          </div>
          <div class="research-overview-metrics">
            <div>
              <span>对标账号</span><strong>{{ overview?.accounts ?? '—' }}<small>个</small></strong>
              <p>{{ overview?.monitoring ?? 0 }} 个账号监控中</p>
            </div>
            <div>
              <span>已采集作品</span><strong>{{ overview?.videos ?? '—' }}<small>条</small></strong>
              <p>视频来源与数据均可追溯</p>
            </div>
            <div>
              <span>已识别爆款</span><strong>{{ overview?.hotVideos ?? '—' }}<small>条</small></strong>
              <p>同账号基线 ×{{ overview?.methodology.multiplier || 3 }}</p>
            </div>
            <div>
              <span>累计赞评转</span><strong>{{ overview ? fmtNum(overview.interactions) : '—' }}</strong>
              <p>{{ overview?.lastFetchedAt ? '最近采集 ' + fmtTime(overview.lastFetchedAt) : '等待首次真实采集' }}</p>
            </div>
          </div>
          <div class="research-overview-foot">
            <span>① 采集对标作品</span><i>→</i><span>② 比较互动表现</span><i>→</i><span>③ 提取与拆解</span><i>→</i
            ><span>④ 送文案工坊</span><button @click="methodologyVisible = true">查看完整方法论 ↗</button>
          </div>
          <p v-if="overviewError" class="research-error" role="alert">{{ overviewError }}</p>
        </section>
        <!-- 账号管理条 -->
        <div class="mw-card p-5 research-accounts">
          <div class="flex items-center gap-3 flex-wrap">
            <span class="text-[15px] font-semibold">对标账号</span>
            <span class="mw-tag mw-tag-gray">{{ bench.realAccounts.length }} 个</span>
            <div class="flex-1"></div>
            <a-tooltip v-if="bench.quota" :content="quotaTip">
              <span class="mw-subtle cursor-help">
                <icon-info-circle :size="13" class="mr-1" />预计日调用
                <b class="text-[var(--mw-text)]">{{ bench.quota.dailyCalls }}</b> 次 · 估算费用
                <b class="text-[var(--mw-text)]">¥{{ bench.quota.estimatedCost.toFixed(2) }}</b
                >/天
              </span>
            </a-tooltip>
          </div>

          <div v-if="bench.realAccounts.length" class="mt-3 research-account-grid">
            <div
              v-for="a in bench.realAccounts"
              :key="a.id"
              class="research-account-card p-3 rounded-[10px] border flex items-center gap-3"
              :class="
                isAbnormal(a)
                  ? 'border-[color:var(--mw-danger,#c03e35)] bg-[#fdeeee]'
                  : 'border-[var(--mw-border-light)] bg-[#fafbfc]'
              "
            >
              <a-avatar :size="36" :style="{ backgroundColor: '#dbe6f6', color: '#1d4ed8', flexShrink: 0 }">
                {{ (a.nickname || '?').slice(0, 1) }}
              </a-avatar>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <button
                    class="research-account-name text-[13.5px] font-semibold truncate"
                    :aria-label="`查看${a.nickname}的视频`"
                    @click="onAccountFilter(a.id)"
                  >
                    {{ a.nickname }}
                  </button>
                  <a-tag v-if="a.monitorStatus === 'paused'" size="small" color="gray">已暂停</a-tag>
                  <a-tag v-else-if="isAbnormal(a)" size="small" color="red">异常</a-tag>
                  <a-tag v-else size="small" color="green">监控中</a-tag>
                </div>
                <div class="mt-0.5 text-[12px] text-[var(--mw-text3)] truncate">
                  粉丝 {{ fmtNum(a.fansCount) }} · 每 {{ a.monitorIntervalHours }}h · 下次 {{ fmtTime(a.nextCheckAt) }}
                </div>
                <div v-if="a.lastError" class="mt-0.5 text-[12px] text-[#c03e35] truncate">
                  连续失败 {{ a.consecutiveFailures }} 次：{{ a.lastError }}
                </div>
              </div>
              <div class="flex items-center gap-1 flex-shrink-0">
                <a-tooltip content="立即检查一次">
                  <a-button
                    size="mini"
                    type="text"
                    :loading="!!pendingFetch[a.id]"
                    :aria-label="`立即同步${a.nickname}`"
                    @click="onFetchNow(a)"
                  >
                    <template #icon><icon-refresh /></template>
                  </a-button>
                </a-tooltip>
                <a-tooltip :content="a.monitorStatus === 'paused' ? '恢复监控' : '暂停监控'">
                  <a-button size="mini" type="text" @click="onToggleMonitor(a)">
                    <template #icon
                      ><icon-pause v-if="a.monitorStatus !== 'paused'" /><icon-play-arrow v-else
                    /></template>
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
        <div class="mw-card p-4">
          <div class="flex items-center gap-3">
            <span class="text-[15px] font-semibold">监控告警</span>
            <a-badge :count="bench.unread" :max-count="99">
              <span class="mw-tag mw-tag-yellow">未读</span>
            </a-badge>
            <div class="flex-1"></div>
            <a-button size="small" type="text" @click="showBenchAlerts = !showBenchAlerts">{{
              showBenchAlerts ? '收起告警' : '展开告警'
            }}</a-button>
            <a-button size="small" type="text" :disabled="!bench.unread" @click="onReadAll">全部标为已读</a-button>
            <a-button size="small" type="text" @click="refreshAlerts">
              <template #icon><icon-refresh /></template>
            </a-button>
          </div>

          <div v-if="showBenchAlerts && bench.alerts.length" class="mt-3 flex flex-col gap-2 research-alert-list">
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
              <a-button v-if="!al.isRead" size="mini" type="text" @click="() => bench.markRead(al.id)"
                >标为已读</a-button
              >
            </div>
          </div>
          <div v-else-if="showBenchAlerts" class="mt-2 mw-subtle">
            暂无告警。首次回填不产生告警，后续新作品或新爆款会出现在这里。
          </div>
        </div>

        <!-- 视频筛选 -->
        <div class="research-filters flex items-center gap-2 flex-wrap">
          <a-select
            :model-value="bench.videoFilter.accountId || ''"
            :style="{ width: '200px' }"
            placeholder="全部账号"
            allow-clear
            @change="onAccountFilter"
          >
            <a-option value="">全部账号</a-option>
            <a-option v-for="a in bench.realAccounts" :key="a.id" :value="a.id">{{ a.nickname }}</a-option>
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
          <a-select
            :model-value="bench.videoFilter.format || ''"
            aria-label="视频画幅"
            :style="{ width: '112px' }"
            @change="onFormatFilter"
            ><a-option value="">全部画幅</a-option><a-option value="landscape">横屏视频</a-option
            ><a-option value="portrait">竖屏视频</a-option><a-option value="square">方屏视频</a-option></a-select
          >
          <a-select
            :model-value="bench.videoFilter.sort || 'latest'"
            aria-label="视频排序"
            :style="{ width: '112px' }"
            @change="onVideoSort"
            ><a-option value="latest">最新发布</a-option><a-option value="interaction">互动最多</a-option></a-select
          >
          <div class="flex-1"></div>
          <span class="mw-subtle">共 {{ bench.videoTotal }} 条</span>
          <a-button size="small" type="text" :loading="bench.videosLoading" @click="() => bench.loadVideos()">
            <template #icon><icon-refresh /></template>
          </a-button>
        </div>

        <!-- 视频网格 -->
        <a-spin :loading="bench.videosLoading" class="w-full">
          <div class="research-video-grid">
            <BenchmarkVideoCard
              v-for="v in bench.videos"
              :key="v.id"
              :video="v"
              :active="activeVideoId === v.id"
              :extraction-ready="overview?.extractionReady"
              @play="activeVideoId = $event"
              @detail="openVideoDetail"
              @extract="onDetailExtract"
              @send="openSendCopy"
            />
          </div>
          <a-empty v-if="!bench.videosLoading && !bench.videos.length" description="暂无视频，添加一个对标账号吧" />
        </a-spin>
        <p v-if="overview?.extractionReady === false" class="research-notice">
          视频与互动数据已接入。提取口播全文还需配置真实 ASR 和音频中转服务，配置完成后开放提取。
        </p>

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
    </section>

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
          <div>
            <b>{{ accModal.previewed.nickname }}</b> · 粉丝 {{ fmtNum(accModal.previewed.fansCount) }}
          </div>
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
          <template #extra><span class="mw-subtle">最短 1 小时；周期越短，日调用量与费用越高。</span></template>
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
    <a-modal
      v-model:visible="scriptModal.visible"
      title="文案提取结果"
      class="benchmark-script-modal"
      width="720px"
      footer
    >
      <template #footer>
        <a-button type="primary" @click="scriptModal.visible = false">关闭</a-button>
      </template>
      <a-spin :loading="scriptModal.loading">
        <div v-if="scriptModal.data">
          <h3 class="research-section-title !mt-0">{{ scriptModal.title }}</h3>
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
            <a-option v-for="p in personas.items" :key="p.id" :value="p.id" :disabled="!p.usable">
              {{ p.name }}
              <span class="mw-subtle ml-1">{{
                p.usable ? p.ipProfile.role : `不可选：${personas.reasonOf(p.id)}`
              }}</span>
            </a-option>
          </a-select>
          <template #extra
            ><span class="mw-subtle">将按「视频 × 人物」展开创建文案草稿，并带上提取全文与句级时间戳。</span></template
          >
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
    <!-- ============ 抽屉：资讯详情（点击标题打开） ============ -->
    <a-drawer v-model:visible="newsDetail.visible" :width="560" :footer="false" unmount-on-close title="资讯详情">
      <a-spin :loading="newsDetail.loading" class="w-full">
        <template v-if="newsDetail.item">
          <div class="flex items-center gap-2 text-[12px] text-[var(--mw-text3)]">
            <span :class="CAT_CLASS[newsDetail.item.category] || 'mw-tag mw-tag-gray'">
              {{ newsDetail.item.category }}
            </span>
            <span>{{ newsDetail.item.source }}</span>
            <span v-if="newsDetail.item.publishedAt">· {{ fmtFullTime(newsDetail.item.publishedAt) }}</span>
          </div>

          <h2 class="mt-3 text-[19px] font-semibold leading-8 text-[#131f38]">{{ newsDetail.item.title }}</h2>

          <div v-if="newsDetail.item.summary" class="mt-4 text-[14px] leading-[1.9] text-[#3c4a63] whitespace-pre-wrap">
            {{ newsDetail.item.summary }}
          </div>
          <a-empty v-else description="该资讯未提供正文内容" class="mt-6" />

          <div class="mt-6 pt-4 border-t border-[#eef2f8] flex items-center gap-3">
            <a-button v-if="newsDetail.item.contentUrl" type="primary" @click="openOrigin(newsDetail.item.contentUrl)">
              <template #icon><icon-launch /></template>打开原文
            </a-button>
            <span v-else class="mw-subtle text-[12px]">该来源未提供原文链接</span>
            <span class="flex-1"></span>
            <span class="mw-subtle text-[12px]">采集于 {{ fmtFullTime(newsDetail.item.fetchedAt) }}</span>
          </div>
        </template>
      </a-spin>
    </a-drawer>
    <TopicMethodology
      :visible="methodologyVisible"
      :templates="topics.templates"
      :overview="overview"
      @close="methodologyVisible = false"
      @use="useMethodology"
    />
    <BenchmarkVideoDrawer
      :video="detailVideo"
      :overview="overview"
      @close="detailVideo = null"
      @extract="onDetailExtract"
      @send="onDetailSend"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Message, Modal } from '@arco-design/web-vue'
import BenchmarkVideoCard from './BenchmarkVideoCard.vue'
import TopicMethodology from './TopicMethodology.vue'
import BenchmarkVideoDrawer from './BenchmarkVideoDrawer.vue'
import { getResearchOverview, type ResearchOverview } from '@/api/benchmark'
import { ApiError } from '@/api/client'
import { getNewsDetail, type NewsItem } from '@/api/news'
import type { Account, AccountPreview, BenchVideo, ExtractStatus, VideoScript } from '@/api/benchmark'
import type { TopicTemplate } from '@/api/topics'
import { CAT_CLASS, useNewsStore } from '@/stores/news'
import { useTopicStore, type CandidateFilter } from '@/stores/topics'
import { usePersonaStore } from '@/stores/personas'
import { EXTRACT_LABEL, useBenchmarkStore } from '@/stores/benchmark'

const router = useRouter()
const tab = ref('news')

const news = useNewsStore()
const topics = useTopicStore()
const personas = usePersonaStore()
const bench = useBenchmarkStore()
const methodologyVisible = ref(false)
const showBenchAlerts = ref(false)
const detailVideo = ref<BenchVideo | null>(null)
function openVideoDetail(v: BenchVideo): void {
  activeVideoId.value = null
  detailVideo.value = v
}
const activeVideoId = ref<string | null>(null)
const overview = ref<ResearchOverview | null>(null)
const overviewError = ref('')
const pendingFetch = ref<Record<string, { lastChecked: string | null; started: number }>>({})
async function loadOverview() {
  try {
    overview.value = await getResearchOverview()
    overviewError.value = ''
  } catch (e) {
    overviewError.value = errOf(e)
  }
}
function useMethodology(id: string) {
  templateId.value = id
  tab.value = 'news'
  methodologyVisible.value = false
}
function onDetailExtract(v: BenchVideo) {
  activeVideoId.value = null
  detailVideo.value = null
  if (v.extractStatus === 'done') void openScript(v)
  else void onExtract(v)
}
function onDetailSend(v: BenchVideo) {
  detailVideo.value = null
  openSendCopy(v)
}

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

/* ── 资讯详情（点击标题打开）─────────────── */
/**
 * 详情抽屉状态。
 *
 * 交互设计：点击标题先用**列表已有数据**立即渲染，再异步拉详情接口刷新。
 * 资讯列表返回的字段（title/summary/contentUrl/publishedAt）已足够展示，
 * 若点击后先转圈等接口，用户会感到明显延迟；而详情接口的价值在于拿到
 * 后台采集可能更新过的完整记录，所以放在后台补正。
 */
const newsDetail = reactive({
  visible: false,
  loading: false,
  item: null as NewsItem | null,
})

async function openNewsDetail(n: NewsItem): Promise<void> {
  newsDetail.item = n
  newsDetail.visible = true
  newsDetail.loading = true
  try {
    newsDetail.item = await getNewsDetail(n.id)
  } catch {
    // 详情拉取失败不打断阅读：列表数据已经能看，保持当前内容即可
  } finally {
    newsDetail.loading = false
  }
}

function openOrigin(url: string | null): void {
  if (!url) return
  window.open(url, '_blank', 'noopener,noreferrer')
}

async function onArchive(id: string) {
  try {
    await topics.archive(id)
    Message.success('已归档')
  } catch (e) {
    Message.error(errOf(e))
  }
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
  intervalHours: 24,
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
  accModal.intervalHours = 24
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
    pendingFetch.value[a.id] = { lastChecked: a.lastCheckedAt, started: Date.now() }
    Message.success(`已添加「${a.nickname}」，正在后台回填最近作品`)
    resetAccModal()
    void bench.loadVideos()
  } catch (e) {
    Message.error(errOf(e))
  } finally {
    accModal.submitting = false
  }
}

/** 以后端 abnormalAt（连续 3 个周期失败才置）为准；偶发一次失败只显示原因，不标异常 */
function isAbnormal(a: Account) {
  return a.monitorStatus === 'on' && !!a.abnormalAt
}

const quotaTip = computed(() => {
  const q = bench.quota
  if (!q) return ''
  const p = q.unitPrice
  return `${q.accounts} 个账号 · 单次作品列表 ¥${p.postList}、用户信息 ¥${p.userInfo}、视频详情 ¥${p.videoDetail}`
})

async function onFetchNow(a: Account) {
  if (pendingFetch.value[a.id]) return
  try {
    await bench.fetchNow(a.id)
    pendingFetch.value[a.id] = { lastChecked: a.lastCheckedAt, started: Date.now() }
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
function onFormatFilter(v: unknown) {
  void bench.loadVideos({ format: v ? (String(v) as 'landscape' | 'portrait' | 'square') : undefined })
}
function onVideoSort(v: unknown) {
  void bench.loadVideos({ sort: String(v) as 'latest' | 'interaction' })
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
  activeVideoId.value = null
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
  activeVideoId.value = null
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
/** 详情抽屉用完整时间：资讯详情需要看清年月日，不能只有「10-17 21:20」 */
function fmtFullTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const pad = (n: number) => String(n).padStart(2, '0')
  return s >= 3600
    ? `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
    : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}
function mmss(ms: number): string {
  const s = Math.floor((ms || 0) / 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}

/* ── 轮询：提取中状态 + 未读告警 ────────── */
let extractTimer: number | undefined
let alertTimer: number | undefined

onMounted(() => {
  void loadOverview()
  void personas.load()
  void news.loadCategories()
  void news.load()
  void topics.load()
  void topics.loadTemplates()
  // P2-22：刷新页面前有未结束的生成批次时继续轮询，结束后展示该批结果
  void topics.resumeBatch().then((b) => {
    if (b?.status === 'done') Message.success(`上次的生成批次已完成，共 ${b.produced} 条候选`)
  })
  void bench.loadAccounts()
  void bench.loadQuota()
  void bench.loadVideos()
  void bench.loadAlerts()
  void bench.loadUnread()

  extractTimer = window.setInterval(() => {
    if (tab.value === 'bench' && bench.hasExtracting) void bench.loadVideos().catch(() => {})
    if (Object.keys(pendingFetch.value).length) void pollAccountFetch()
  }, 3000)
  alertTimer = window.setInterval(() => {
    if (tab.value === 'bench') void bench.loadUnread()
  }, 30_000)
})

onUnmounted(() => {
  if (extractTimer) window.clearInterval(extractTimer)
  if (alertTimer) window.clearInterval(alertTimer)
})

let checkingFetch = false
async function pollAccountFetch() {
  if (checkingFetch) return
  checkingFetch = true
  try {
    await bench.loadAccounts()
    for (const [id, pending] of Object.entries(pendingFetch.value)) {
      const a = bench.accounts.find((x) => x.id === id)
      if (!a || (a.lastCheckedAt && a.lastCheckedAt !== pending.lastChecked)) {
        delete pendingFetch.value[id]
        if (a?.lastError) Message.error(a.lastError)
        else if (a) Message.success(`「${a.nickname}」视频同步完成`)
      } else if (Date.now() - pending.started > 120_000) {
        delete pendingFetch.value[id]
        Message.warning('同步仍在后台进行，可稍后刷新查看账号状态')
      }
    }
    await Promise.all([bench.loadVideos(), loadOverview(), bench.loadQuota()])
  } catch (e) {
    overviewError.value = errOf(e)
  } finally {
    checkingFetch = false
  }
}
</script>
