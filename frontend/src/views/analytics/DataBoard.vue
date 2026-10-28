<template>
  <div class="p-7 pb-10 max-w-[1440px] mx-auto">
    <PageHead title="数据看板">
      <template #sub>从内容表现，找到下一轮选题线索</template>
      <template #actions>
        <div class="flex items-center gap-2">
          <a-button v-if="canWrite" :loading="store.acting" @click="openImport">
            <template #icon><icon-upload /></template>
            导入回采数据
          </a-button>
          <a-button type="primary" @click="goTopic">
            查看选题建议<template v-if="store.pendingCount > 0"> · {{ store.pendingCount }}</template>
          </a-button>
        </div>
      </template>
    </PageHead>

    <a-tabs :active-key="store.tab" type="line" class="mw-tabs" @change="onTabChange">
      <a-tab-pane key="effect" title="效果看板" />
      <a-tab-pane key="feature" title="特征沉淀" />
      <a-tab-pane key="topic" title="选题反馈" />
    </a-tabs>

    <!-- ============ 效果看板 ============ -->
    <div v-if="store.tab === 'effect'">
      <!-- 筛选行 -->
      <div class="flex flex-wrap items-center gap-2.5 mb-4 -mt-1">
        <a-select v-model="store.days" :style="{ width: '100px' }" @change="reloadOverview">
          <a-option v-for="d in DAY_OPTIONS" :key="d.value" :value="d.value">{{ d.label }}</a-option>
        </a-select>
        <a-select v-model="store.line" :style="{ width: '120px' }" @change="reloadOverview">
          <a-option value="">全部生产线</a-option>
          <a-option v-for="l in LINE_OPTIONS" :key="l.value" :value="l.value">{{ l.label }}</a-option>
        </a-select>
        <a-select v-model="store.platform" :style="{ width: '110px' }" @change="reloadOverview">
          <a-option value="">全部平台</a-option>
          <a-option v-for="p in PLATFORM_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</a-option>
        </a-select>
        <div class="flex-1"></div>
        <span class="mw-subtle whitespace-nowrap">{{ store.rangeText || '—' }}</span>
      </div>

      <!-- 采集状态（FR-M10 最近回步 + DB8 提示条） -->
      <div class="mw-card px-5 py-3 mb-5 flex flex-wrap items-center gap-x-4 gap-y-2">
        <span class="mw-tag mw-tag-blue">回采方式：{{ providerLabel }}</span>
        <span class="mw-subtle">
          T+1 最近导入 {{ fmtTime(capture.t1.lastCapturedAt)
          }}<template v-if="capture.t1.pending"> · 待回采 {{ capture.t1.pending }} 条</template>
        </span>
        <span class="mw-subtle">
          T+7 最近导入 {{ fmtTime(capture.t7.lastCapturedAt)
          }}<template v-if="capture.t7.pending"> · 待回采 {{ capture.t7.pending }} 条</template>
        </span>
        <span class="mw-subtle flex-1 min-w-[200px]">{{ store.providerHint }}</span>
        <a-button v-if="isAdmin" size="mini" :loading="store.acting" @click="onCollect">检查到期记录</a-button>
        <a-button size="mini" type="text" :loading="store.overviewLoading" @click="reloadOverview">刷新</a-button>
      </div>

      <div v-if="store.overviewLoading && !store.overview" class="mw-card p-12 text-center">
        <a-spin />
        <div class="mw-subtle mt-3">正在汇总回采数据…</div>
      </div>

      <div v-else-if="store.overviewError" class="mw-card p-10 text-center">
        <icon-exclamation-circle :size="32" class="text-[var(--mw-text3)]" />
        <div class="text-[15px] font-semibold mt-2">看板数据加载失败</div>
        <div class="mw-subtle mt-1">{{ store.overviewError }}</div>
        <a-button class="mt-4" size="small" @click="reloadOverview">重试</a-button>
      </div>

      <div v-else-if="!store.overview || store.overview.empty" class="mw-card p-12 text-center">
        <icon-bar-chart :size="40" class="text-[var(--mw-text3)]" />
        <div class="text-[16px] font-semibold mt-2">发布首批内容并导入 CSV 回采数据</div>
        <div class="mw-subtle max-w-[460px] mx-auto leading-6 mt-1">
          看板只展示真实回采数据，不做估算。内容发布后从平台创作者中心导出 CSV 导入，即可看到播放、互动与爆款判定； T+1
          / T+7 两个窗口分别留存。
        </div>
        <div class="flex items-center justify-center gap-2 mt-4">
          <a-button v-if="canWrite" type="primary" size="small" @click="openImport">导入回采数据</a-button>
          <a-button size="small" @click="reloadOverview">我已经导入过，刷新</a-button>
        </div>
      </div>

      <template v-else>
        <!-- 指标卡 -->
        <div class="grid grid-cols-3 gap-5 mb-5">
          <div class="mw-card p-5 flex items-center justify-between">
            <div>
              <div class="mw-subtle">发布作品</div>
              <div class="text-[32px] font-bold leading-[1.2] mt-1.5 tracking-tight">
                {{ store.overview.cards.published }}
                <span class="text-[14px] font-medium text-[var(--mw-text3)]">条</span>
              </div>
              <div class="mw-subtle mt-1">已回采 {{ store.overview.cards.captured }} 条</div>
            </div>
            <div
              class="w-11 h-11 rounded-full flex items-center justify-center bg-[var(--mw-primary-bg)] text-[var(--mw-primary)]"
            >
              <icon-file :size="19" />
            </div>
          </div>
          <div class="mw-card p-5 flex items-center justify-between">
            <div>
              <div class="mw-subtle">播放量</div>
              <div class="text-[32px] font-bold leading-[1.2] mt-1.5 tracking-tight">
                {{ fmtCount(store.overview.cards.plays) }}
              </div>
              <div class="mw-subtle mt-1">每内容取最新窗口（T+7 优先）</div>
            </div>
            <div class="w-11 h-11 rounded-full flex items-center justify-center bg-[#e9f3ff] text-[#1c7bd8]">
              <icon-play-circle-fill :size="19" />
            </div>
          </div>
          <div class="mw-card p-5 flex items-center justify-between">
            <div>
              <div class="mw-subtle">互动量</div>
              <div class="text-[32px] font-bold leading-[1.2] mt-1.5 tracking-tight">
                {{ fmtCount(store.overview.cards.interacts) }}
              </div>
              <div class="mw-subtle mt-1">爆款 {{ store.overview.cards.hotCount }} 条 · 赞+评+转+藏</div>
            </div>
            <div class="w-11 h-11 rounded-full flex items-center justify-center bg-[#fdeef2] text-[#d8497b]">
              <icon-heart-fill :size="19" />
            </div>
          </div>
        </div>

        <!-- 趋势 + 生产线表现 -->
        <div class="grid grid-cols-[1.9fr_1fr] gap-5 mb-5">
          <div class="mw-card p-5">
            <div class="flex items-center gap-4">
              <div class="text-[15px] font-semibold">播放趋势</div>
              <div class="flex items-center gap-3 ml-auto">
                <span
                  v-for="s in trend.series"
                  :key="s.name"
                  class="flex items-center gap-1.5 text-[12px] text-[var(--mw-text2)]"
                >
                  <span class="mw-dot" :style="{ background: s.color }"></span>{{ s.name }}
                </span>
              </div>
            </div>
            <div class="mw-subtle mt-0.5">各线按自身峰值标准化，只用于看变化趋势，绝对值见下方内容表现</div>
            <svg viewBox="0 0 620 190" class="w-full mt-2">
              <defs>
                <linearGradient id="mwAreaMain" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#344f61" stop-opacity="0.13" />
                  <stop offset="100%" stop-color="#344f61" stop-opacity="0" />
                </linearGradient>
              </defs>
              <g v-for="(y, i) in [0, 33, 66, 100]" :key="i">
                <text x="18" :y="yAt(y) + 4" font-size="10" fill="#a5aebc">{{ y }}</text>
                <line x1="34" :y1="yAt(y)" x2="600" :y2="yAt(y)" stroke="#eef1f5" stroke-dasharray="3 4" />
              </g>
              <path v-if="trend.series.length" :d="areaPath(trend.series[0].values)" fill="url(#mwAreaMain)" />
              <template v-for="s in trend.series" :key="s.name">
                <path :d="linePath(s.values)" fill="none" :stroke="s.color" stroke-width="2" stroke-linecap="round" />
                <template v-if="s.values.length <= 14">
                  <circle
                    v-for="(v, i) in s.values"
                    :key="i"
                    :cx="xAt(i, s.values.length)"
                    :cy="yAt(v)"
                    r="3"
                    fill="#fff"
                    :stroke="s.color"
                    stroke-width="2"
                  />
                </template>
              </template>
              <text
                v-for="d in trend.dayLabels"
                :key="d.key"
                :x="d.x"
                y="184"
                font-size="10"
                fill="#a5aebc"
                text-anchor="middle"
              >
                {{ d.text }}
              </text>
            </svg>
          </div>
          <div class="mw-card p-5">
            <div class="text-[15px] font-semibold">各生产线表现</div>
            <div class="mt-4 flex flex-col gap-4">
              <div v-for="s in store.overview.lines" :key="s.line" class="flex items-center gap-3">
                <span
                  class="w-9 h-9 rounded-full flex items-center justify-center bg-[var(--mw-primary-bg)]"
                  aria-hidden="true"
                >
                  <span class="w-4 h-4 rounded-full" :style="{ background: lineColor(s.line) }"></span>
                </span>
                <span class="text-[14px] font-medium w-16">{{ s.name }}</span>
                <span class="text-[15px] font-bold">{{ s.count }} 条</span>
                <div class="flex-1"></div>
                <span class="mw-subtle">单条均播</span>
                <span class="text-[17px] font-bold ml-1">{{ fmtCount(s.avgPlays) }}</span>
              </div>
              <div v-if="!store.overview.lines.length" class="mw-subtle">所选区间内暂无已发布内容</div>
            </div>
            <div class="mt-4 pt-3 border-t border-[var(--mw-border-light)] mw-subtle">
              跨线对比需考虑账号基数与平台差异。
            </div>
          </div>
        </div>

        <!-- 内容表现 + 选题建议 -->
        <div class="grid grid-cols-[1.9fr_1fr] gap-5">
          <div class="mw-card p-5">
            <div class="flex items-center justify-between mb-3">
              <div class="text-[15px] font-semibold">内容表现</div>
              <span class="mw-tag mw-tag-blue">T+1 / T+7 独立快照</span>
            </div>
            <div class="overflow-x-auto">
              <div class="min-w-[780px]">
                <div
                  class="grid grid-cols-[2.4fr_0.7fr_0.9fr_0.8fr_0.8fr_0.8fr_0.8fr_1fr] text-[12px] text-[var(--mw-text3)] pb-2 border-b border-[var(--mw-border)]"
                >
                  <span>内容</span><span>平台</span><span>账号</span><span>T+1 播放</span><span>T+7 播放</span
                  ><span>互动</span><span>完播率</span><span>判定</span>
                </div>
                <div
                  v-for="r in store.overview.contents.items"
                  :key="r.publishLogId"
                  class="grid grid-cols-[2.4fr_0.7fr_0.9fr_0.8fr_0.8fr_0.8fr_0.8fr_1fr] items-center py-2.5 border-b border-[var(--mw-border-light)] last:border-none"
                >
                  <div class="min-w-0 pr-2">
                    <div class="text-[13px] font-medium truncate" :title="r.title">{{ r.title }}</div>
                    <div class="mw-subtle truncate">{{ r.personaName || r.lineLabel || '未关联人物' }}</div>
                  </div>
                  <span class="text-[13px]">{{ r.platformLabel }}</span>
                  <span class="text-[13px] truncate" :title="r.accountName || ''">{{ r.accountName || '—' }}</span>
                  <span class="text-[13.5px] font-semibold">{{ fmtCount(r.playsT1) }}</span>
                  <span class="text-[13.5px] font-semibold">{{ fmtCount(r.playsT7) }}</span>
                  <span class="text-[13px]">{{ fmtCount(r.interacts) }}</span>
                  <span class="text-[13px] text-[var(--mw-text3)]">{{ fmtRate(r.completionRate) }}</span>
                  <div class="flex items-center gap-1.5">
                    <span v-if="r.isHot === 1" class="mw-tag mw-tag-yellow">爆款</span>
                    <span v-else-if="r.isHot === null" class="mw-tag mw-tag-gray">样本不足</span>
                    <a-tooltip
                      v-if="r.benchmark"
                      :content="`对标「${r.benchmark.nickname || '账号'}」当前每 ${r.benchmark.intervalHours} 小时巡一次`"
                    >
                      <a-button size="mini" type="text" :loading="store.acting" @click="onRaise(r)">提升监控</a-button>
                    </a-tooltip>
                  </div>
                </div>
                <div v-if="!store.overview.contents.items.length" class="mw-subtle py-6 text-center">
                  所选区间内暂无已发布内容
                </div>
              </div>
            </div>
            <div class="mt-3 flex flex-wrap items-center justify-between gap-2">
              <span class="mw-subtle">— 表示尚未取得或待验证，不按 0 计入；判定列空白表示未达爆款阈值。</span>
              <span class="mw-subtle">爆款口径：播放高于账号近 90 天均值 3 倍（样本不足 5 条不判定）。</span>
            </div>
            <div v-if="store.overview.contents.total > store.overview.contents.items.length" class="mw-subtle mt-1">
              共 {{ store.overview.contents.total }} 条，此处显示最近 {{ store.overview.contents.items.length }} 条。
            </div>
          </div>

          <div class="mw-card p-5">
            <div class="text-[15px] font-semibold mb-3">
              待确认的选题建议
              <span class="text-[color:var(--mw-primary)]">{{ store.pendingCount }}</span>
            </div>
            <template v-if="pendingPreview.length">
              <div
                v-for="s in pendingPreview"
                :key="s.id"
                class="p-4 rounded-[10px] border border-[var(--mw-primary-ring)] bg-[var(--mw-primary-bg)] mb-3"
              >
                <div class="flex items-center gap-2 text-[12.5px] font-medium text-[color:var(--mw-primary)]">
                  <icon-bar-chart :size="14" />{{ dimLabel(s) }}
                </div>
                <div class="mt-2 flex items-start gap-2">
                  <span class="text-[14px] font-semibold flex-1 leading-5">{{ suggestionTitle(s) }}</span>
                  <span class="mw-tag mw-tag-yellow flex-shrink-0">待运营确认</span>
                </div>
                <div class="mw-subtle mt-2">{{ suggestionBasis(s) }}</div>
              </div>
            </template>
            <div v-else class="mw-subtle py-3 leading-6">
              暂无待确认建议。爆款样本达到门槛后，方向 / 时长 / 钩子的高占比取值会自动出现在这里。
            </div>
            <div class="mt-2 flex items-center justify-center gap-2 text-[12px] text-[var(--mw-text2)]">
              <span class="px-2.5 py-1 rounded-full bg-[#f4f5f7]">数据观察</span>
              <icon-right :size="12" class="text-[var(--mw-text3)]" />
              <span class="px-2.5 py-1 rounded-full bg-[#f4f5f7]">人工确认</span>
              <icon-right :size="12" class="text-[var(--mw-text3)]" />
              <span class="px-2.5 py-1 rounded-full bg-[#f4f5f7]">选题候选</span>
            </div>
            <div class="mt-4 pt-3 border-t border-[var(--mw-border-light)] mw-subtle flex items-center gap-1">
              <icon-info-circle :size="12" />相关性观察，不代表因果结论。
            </div>
            <a-button v-if="store.pendingCount" long size="small" class="mt-3" @click="goTopic"
              >去选题反馈处理</a-button
            >
          </div>
        </div>
      </template>
    </div>

    <!-- ============ 特征沉淀 ============ -->
    <div v-else-if="store.tab === 'feature'">
      <div class="flex flex-wrap items-center gap-2.5 mb-4 -mt-1">
        <a-radio-group v-model="store.featureWindow" type="button" size="small" @change="reloadFeatures">
          <a-radio value="t1">T+1</a-radio>
          <a-radio value="t7">T+7</a-radio>
        </a-radio-group>
        <a-select v-model="store.featureDays" :style="{ width: '110px' }" @change="reloadFeatures">
          <a-option v-for="d in DAY_OPTIONS" :key="d.value" :value="d.value">{{ d.label }}</a-option>
        </a-select>
        <div class="flex-1"></div>
        <a-button size="small" :loading="store.featureLoading" @click="reloadFeatures">刷新</a-button>
        <a-button
          v-if="canWrite"
          type="primary"
          size="small"
          :disabled="!canConfirm"
          :loading="store.acting"
          @click="confirmVisible = true"
          >确认作为生成偏好</a-button
        >
      </div>

      <div v-if="store.featureLoading && !store.features" class="mw-card p-12 text-center">
        <a-spin />
        <div class="mw-subtle mt-3">正在统计爆款特征…</div>
      </div>

      <div v-else-if="store.featureError" class="mw-card p-10 text-center">
        <icon-exclamation-circle :size="32" class="text-[var(--mw-text3)]" />
        <div class="text-[15px] font-semibold mt-2">特征统计加载失败</div>
        <div class="mw-subtle mt-1">{{ store.featureError }}</div>
        <a-button class="mt-4" size="small" @click="reloadFeatures">重试</a-button>
      </div>

      <div v-else-if="!store.features || store.features.empty" class="mw-card p-12 text-center">
        <icon-bar-chart :size="40" class="text-[var(--mw-text3)]" />
        <div class="text-[16px] font-semibold mt-2">发布首批内容并导入 CSV 回采数据</div>
        <div class="mw-subtle max-w-[460px] mx-auto leading-6 mt-1">
          特征沉淀需要 {{ store.featureWindow === 't1' ? 'T+1' : 'T+7' }} 窗口的爆款样本：导入回采数据后，
          这里会给出五个维度的高表现取值与爆款占比。
        </div>
        <a-button v-if="canWrite" type="primary" size="small" class="mt-4" @click="openImport">导入回采数据</a-button>
      </div>

      <template v-else>
        <div class="mw-card p-5">
          <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div class="text-[15px] font-semibold">
              爆款特征沉淀
              <span class="mw-tag mw-tag-blue ml-2">{{ store.featureWindow === 't1' ? 'T+1' : 'T+7' }} 窗口</span>
            </div>
            <div class="mw-subtle">
              样本 {{ store.features.sampleCount }} 条 · 爆款 {{ store.features.hotCount }} 条 · 近
              {{ store.features.days }} 天
            </div>
          </div>
          <div
            class="grid grid-cols-[1.6fr_1.5fr_0.8fr_0.7fr] text-[12px] text-[var(--mw-text3)] pb-2 border-b border-[var(--mw-border)]"
          >
            <span>特征维度</span><span>高表现取值</span><span>爆款占比</span><span>状态</span>
          </div>
          <div
            v-for="f in store.features.dims"
            :key="f.key"
            class="grid grid-cols-[1.6fr_1.5fr_0.8fr_0.7fr] items-center py-3 border-b border-[var(--mw-border-light)] last:border-none text-[13px]"
          >
            <span class="flex items-center gap-1.5">
              {{ f.label }}
              <a-tooltip :content="f.note"><icon-info-circle :size="12" class="text-[var(--mw-text3)]" /></a-tooltip>
            </span>
            <span class="font-medium">
              {{ f.top?.value ?? '—' }}
              <span v-if="f.validSamples < 3" class="mw-subtle ml-1">（有效样本 {{ f.validSamples }} 条）</span>
            </span>
            <a-tooltip
              v-if="f.top"
              :content="`该取值共 ${f.top.count} 条、其中爆款 ${f.top.hotCount} 条，爆款率 ${pct(f.top.hotRate)}`"
            >
              <span class="cursor-help">{{ pct(f.top.ratio) }}</span>
            </a-tooltip>
            <span v-else>—</span>
            <span>
              <span class="mw-tag" :class="STATUS_TAG[f.status]">{{ f.status }}</span>
            </span>
          </div>
          <div class="mw-subtle mt-3 flex items-center gap-1">
            <icon-info-circle :size="12" />占比 =
            该取值在爆款样本中的占比；确认后作为文案生成的默认偏好（侧重但不强制）。
          </div>
          <div v-if="store.features.hotCount < store.features.minHotSamples" class="mw-subtle mt-1">
            爆款样本不足 {{ store.features.minHotSamples }} 条，暂不能确认偏好——继续积累数据后重试。
          </div>
        </div>

        <div class="mw-card p-5 mt-5">
          <div class="flex items-center justify-between mb-2">
            <div class="text-[15px] font-semibold">当前生效的生成偏好</div>
            <span v-if="store.profile" class="mw-tag mw-tag-green">已生效</span>
            <span v-else class="mw-tag mw-tag-gray">未确认</span>
          </div>
          <template v-if="store.profile">
            <div class="text-[13px] leading-6">{{ store.profile.basisText }}</div>
            <div class="mw-subtle mt-2">
              来源：{{ store.profile.windowBasis === 't1' ? 'T+1' : 'T+7' }} 窗口 · 样本
              {{ store.profile.sampleCount }} 条 · 确认人 {{ store.profile.confirmedBy || '—' }} ·
              {{ fmtTime(store.profile.createdAt) }}
            </div>
          </template>
          <div v-else class="mw-subtle leading-6">
            尚未确认偏好：文案生成只使用人物档案与模板要求，不带数据偏好。确认后本条会成为唯一生效偏好，旧档案自动归档。
          </div>
        </div>
      </template>
    </div>

    <!-- ============ 选题反馈 ============ -->
    <div v-else>
      <div class="flex flex-wrap items-center gap-2.5 mb-4 -mt-1">
        <span class="mw-subtle flex-1">
          建议由当前窗口的特征统计自动生成（占比 ≥ 60% 才产出）；确认后进入选题库，需分配人物才能送入文案工坊。
        </span>
        <a-button size="small" :loading="store.suggestionLoading" @click="reloadSuggestions">刷新</a-button>
        <a-button v-if="canWrite" size="small" :loading="store.acting" @click="onRefreshSuggestions"
          >按最新数据生成建议</a-button
        >
      </div>

      <div v-if="store.suggestionLoading && !store.suggestions.length" class="mw-card p-12 text-center">
        <a-spin />
        <div class="mw-subtle mt-3">正在读取反哺建议…</div>
      </div>

      <div v-else-if="store.suggestionError" class="mw-card p-10 text-center">
        <icon-exclamation-circle :size="32" class="text-[var(--mw-text3)]" />
        <div class="text-[15px] font-semibold mt-2">建议列表加载失败</div>
        <div class="mw-subtle mt-1">{{ store.suggestionError }}</div>
        <a-button class="mt-4" size="small" @click="reloadSuggestions">重试</a-button>
      </div>

      <div v-else-if="!store.suggestions.length" class="mw-card p-12 text-center">
        <icon-bar-chart :size="40" class="text-[var(--mw-text3)]" />
        <div class="text-[16px] font-semibold mt-2">发布首批内容并导入 CSV 回采数据</div>
        <div class="mw-subtle max-w-[460px] mx-auto leading-6 mt-1">
          有爆款样本后，方向 / 时长 / 钩子的高占比取值会作为选题建议出现在这里，人工确认后才进入选题库。
        </div>
        <a-button v-if="canWrite" type="primary" size="small" class="mt-4" @click="openImport">导入回采数据</a-button>
      </div>

      <div v-else class="mw-card p-5">
        <div class="flex items-center justify-between mb-3">
          <div class="text-[15px] font-semibold">反哺选题库</div>
          <span class="mw-subtle">共 {{ store.suggestionTotal }} 条 · 待确认 {{ store.pendingCount }} 条</span>
        </div>
        <div
          v-for="s in store.suggestions"
          :key="s.id"
          class="flex flex-wrap items-center gap-4 py-3.5 border-b border-[var(--mw-border-light)] last:border-none"
        >
          <div class="flex-1 min-w-[260px]">
            <div class="text-[14px] font-medium flex items-center gap-2">
              {{ suggestionTitle(s) }}
              <span class="mw-tag" :class="SUGGESTION_TAG[s.status]">{{ SUGGESTION_LABEL[s.status] }}</span>
            </div>
            <div class="mw-subtle mt-1">依据：{{ suggestionBasis(s) }}</div>
            <div v-if="s.topicId" class="mw-subtle mt-0.5">已生成选题：{{ s.topicId }}</div>
          </div>
          <div v-if="s.status === 'pending' && canWrite" class="flex gap-2">
            <a-button size="small" type="primary" :loading="store.acting" @click="onConfirmSuggestion(s)"
              >加入选题库</a-button
            >
            <a-button size="small" :loading="store.acting" @click="onDismissSuggestion(s)">忽略</a-button>
          </div>
          <div v-else-if="s.status !== 'pending'" class="mw-subtle text-[12px]">
            {{ s.decidedBy || '—' }} · {{ fmtTime(s.decidedAt) }}
          </div>
        </div>
      </div>
    </div>

    <!-- 导入 CSV -->
    <a-modal
      v-model:visible="importVisible"
      title="导入回采数据（CSV）"
      :width="560"
      :mask-closable="false"
      unmount-on-close
      @before-ok="submitImport"
    >
      <div class="flex flex-wrap items-center gap-3 mb-3">
        <a-select v-model="importPlatform" :style="{ width: '140px' }">
          <a-option v-for="p in PLATFORM_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</a-option>
        </a-select>
        <a-select v-model="importWindow" :style="{ width: '130px' }">
          <a-option value="t1">T+1 窗口</a-option>
          <a-option value="t7">T+7 窗口</a-option>
        </a-select>
        <a-button size="small" :loading="store.acting" @click="onDownloadTemplate">下载该平台模板</a-button>
      </div>
      <input
        type="file"
        accept=".csv,text/csv"
        aria-label="选择回采数据 CSV"
        class="block w-full text-[13px] file:mr-3 file:px-3 file:py-1.5 file:rounded file:border-0 file:bg-[var(--mw-primary-bg)] file:text-[var(--mw-primary)]"
        @change="onPickFile"
      />
      <div class="mw-subtle mt-2 leading-5">
        模板列名：{{ templateHeaders || '—' }}<br />
        文件 ≤ 2MB，请用 Excel「另存为 CSV UTF-8」（GBK 编码会被拒）。平台与账号需与发布记录一致；
        无法匹配的行会逐行列出，超过 80% 不匹配时整单拒绝。
      </div>
      <div v-if="importError" class="mt-3 p-2.5 rounded bg-[#fdeeee] text-[#c03e35] text-[12.5px] leading-5">
        {{ importError }}
      </div>
    </a-modal>

    <!-- 导入结果 -->
    <a-modal v-model:visible="resultVisible" title="导入结果" :width="560" :footer="false">
      <template v-if="importResult">
        <div class="grid grid-cols-2 gap-3 mb-3">
          <div class="p-3 rounded bg-[#f7f8f9]">
            <div class="mw-subtle">成功写入</div>
            <div class="text-[20px] font-bold">{{ importResult.imported }} 条</div>
            <div class="mw-subtle mt-0.5">新增 {{ importResult.created }} · 覆盖 {{ importResult.updated }}</div>
          </div>
          <div class="p-3 rounded bg-[#f7f8f9]">
            <div class="mw-subtle">未匹配 / 拒收</div>
            <div class="text-[20px] font-bold">
              {{ importResult.unmatchedCount }} / {{ importResult.rejectedCount }}
            </div>
            <div class="mw-subtle mt-0.5">涉及 {{ importResult.accounts }} 个账号</div>
          </div>
        </div>
        <div class="mw-subtle mb-1">
          {{ importResult.platform }} · {{ importResult.window === 't1' ? 'T+1' : 'T+7' }} · 共
          {{ importResult.total }} 行
          <template v-if="importResult.suggestions">· 新生成建议 {{ importResult.suggestions }} 条</template>
        </div>
        <div v-if="importResult.unmatched.length" class="mt-2">
          <div class="text-[13px] font-medium mb-1">未匹配明细（最多显示 10 条）</div>
          <div
            v-for="u in importResult.unmatched.slice(0, 10)"
            :key="u.lineNo"
            class="text-[12.5px] text-[var(--mw-text2)] py-1 border-b border-[var(--mw-border-light)] last:border-none"
          >
            第 {{ u.lineNo }} 行：{{ u.reason }}<template v-if="u.title">（{{ u.title }}）</template>
          </div>
        </div>
        <div class="mw-subtle mt-3 leading-5">
          同一条内容的同窗口重复导入以最新为准；爆款判定已按账号近 90 天均值同步重算。
        </div>
      </template>
    </a-modal>

    <!-- 确认偏好（二次确认：展示将注入的全文） -->
    <a-modal
      v-model:visible="confirmVisible"
      title="确认作为文案生成偏好"
      :width="560"
      :mask-closable="false"
      unmount-on-close
      ok-text="确认生效"
      @before-ok="submitConfirm"
    >
      <div class="text-[13px] leading-6">
        确认后本条会冻结为唯一生效的偏好（旧的自动归档）。文案工坊生成时，若未填写额外要求，会自动带上下面这段文字：
      </div>
      <div class="mt-2 p-3 rounded bg-[#f7f8f9] text-[13px] leading-6 whitespace-pre-wrap">
        {{ store.features?.basisText || '—' }}
      </div>
      <div class="mw-subtle mt-2 leading-5">仅作侧重参考，不强制套用；人物档案、合规规则与显式填写的要求优先。</div>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import PageHead from '@/components/PageHead.vue'
import { useAuthStore } from '@/stores/auth'
import { DAY_OPTIONS, LINE_OPTIONS, PLATFORM_OPTIONS, useAnalyticsStore, type BoardTab } from '@/stores/analytics'
import type { ContentPerfRow, ImportResult, MetricWindow, Suggestion } from '@/api/analytics'
import type { Platform } from '@/api/publish'

const auth = useAuthStore()
const store = useAnalyticsStore()

const canWrite = computed(() => auth.hasRole('ops', 'admin'))
const isAdmin = computed(() => auth.hasRole('admin'))
const providerLabel = computed(() => {
  const name = store.meta?.provider.name ?? store.overview?.provider.name
  return name === 'creator' ? '创作者中心自动回采' : 'CSV 人工导入'
})

/* ── 常量 ── */

const LINE_COLORS: Record<string, string> = { manager: '#344f61', kos: '#4f7189', persona: '#9db3c2' }
const STATUS_TAG: Record<string, string> = {
  待确认: 'mw-tag-yellow',
  样本不足: 'mw-tag-gray',
  已沉淀: 'mw-tag-green',
}
const SUGGESTION_TAG: Record<Suggestion['status'], string> = {
  pending: 'mw-tag-yellow',
  confirmed: 'mw-tag-green',
  dismissed: 'mw-tag-gray',
}
const SUGGESTION_LABEL: Record<Suggestion['status'], string> = {
  pending: '待确认',
  confirmed: '已加入选题库',
  dismissed: '已忽略',
}

/* ── 格式化 ── */

function fmtCount(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}亿`
  if (v >= 10_000) return `${(v / 10_000).toFixed(1)}万`
  return v.toLocaleString('zh-CN')
}

function fmtRate(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—'
  return `${(v * 100).toFixed(1)}%`
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`
}

/**
 * 服务端两种时间形态都要吃：`fromDb` 返回带 Z 的 ISO8601，`toDb` 返回 `YYYY-MM-DD HH:mm:ss`（无时区，按 UTC 解释）。
 * 统一在这里补时区，避免把「带 Z 的串再拼一个 Z」解析成 Invalid Date。
 */
function parseUtc(value: string): Date | null {
  const t = value.replace(' ', 'T')
  const withZone = /[Zz]|[+-]\d{2}:\d{2}$/.test(t) ? t : `${t}Z`
  const d = new Date(withZone)
  return Number.isNaN(d.getTime()) ? null : d
}

/** UTC 存储 → 北京时间展示 */
function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = parseUtc(iso)
  if (!d) return iso.slice(0, 16)
  const cst = new Date(d.getTime() + 8 * 3600_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(cst.getUTCMonth() + 1)}.${pad(cst.getUTCDate())} ${pad(cst.getUTCHours())}:${pad(cst.getUTCMinutes())}`
}

function lineColor(line: string): string {
  return LINE_COLORS[line] ?? '#344f61'
}

/* ── 趋势图（Catmull-Rom → 贝塞尔，沿用原型绘制口径） ── */

const CHART = { left: 64, right: 596, baseline: 164, scale: 1.5 }

function xAt(i: number, n: number): number {
  if (n <= 1) return CHART.left
  return CHART.left + (i * (CHART.right - CHART.left)) / (n - 1)
}

function yAt(v: number): number {
  return CHART.baseline - v * CHART.scale
}

/** 各线按自身峰值归一到 0~100：跨线量级差异太大，绝对值留在表格里 */
function normalize(values: number[]): number[] {
  const max = values.reduce((a, b) => Math.max(a, b), 0)
  if (!max) return values.map(() => 0)
  return values.map((v) => (v / max) * 100)
}

const trend = computed(() => {
  const t = store.overview?.trend
  const dayKeys = t?.dayKeys ?? []
  const series = (t?.series ?? []).map((s) => ({ name: s.name, color: lineColor(s.line), values: normalize(s.values) }))
  const step = dayKeys.length > 8 ? Math.ceil(dayKeys.length / 7) : 1
  const dayLabels = dayKeys
    .map((key, i) => ({
      key,
      x: xAt(i, dayKeys.length),
      text: key.slice(5).replace('-', '/'),
      show: i % step === 0 || i === dayKeys.length - 1,
    }))
    .filter((d) => d.show)
  return { series, dayLabels }
})

function ptsOf(values: number[]): Array<{ x: number; y: number }> {
  return values.map((v, i) => ({ x: xAt(i, values.length), y: yAt(v) }))
}

function linePath(values: number[]): string {
  const pts = ptsOf(values)
  if (!pts.length) return ''
  if (pts.length === 1) return `M ${pts[0].x},${pts[0].y}`
  let d = `M ${pts[0].x},${pts[0].y}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x},${p2.y}`
  }
  return d
}

function areaPath(values: number[]): string {
  const pts = ptsOf(values)
  if (!pts.length) return ''
  return `${linePath(values)} L ${pts[pts.length - 1].x},${CHART.baseline} L ${pts[0].x},${CHART.baseline} Z`
}

/* ── 采集状态 ── */

const capture = computed(
  () =>
    store.overview?.capture ?? {
      t1: { lastCapturedAt: null, pending: 0 },
      t7: { lastCapturedAt: null, pending: 0 },
    },
)

/* ── 建议展示 ── */

function suggestionTitle(s: Suggestion): string {
  return String((s.payload as { title?: string }).title ?? '数据反哺选题')
}

function suggestionBasis(s: Suggestion): string {
  const basis = s.payload as { basisText?: string }
  if (basis.basisText) return basis.basisText
  const b = s.basis as { dimensionLabel?: string; value?: string; ratio?: number; hotTotal?: number }
  if (!b.dimensionLabel) return '—'
  return `${b.dimensionLabel}「${b.value ?? '—'}」在 ${b.hotTotal ?? 0} 条爆款中占 ${pct(b.ratio ?? 0)}`
}

function dimLabel(s: Suggestion): string {
  return (s.basis as { dimensionLabel?: string }).dimensionLabel ?? '数据观察'
}

const pendingPreview = computed(() => store.suggestions.filter((s) => s.status === 'pending').slice(0, 2))

/* ── 加载与筛选 ── */

onMounted(() => {
  void store.load(true)
})

function onTabChange(key: string | number): void {
  void store.setTab(key as BoardTab)
}

function goTopic(): void {
  void store.setTab('topic')
}

function reloadOverview(): void {
  void store.loadOverview()
}

function reloadFeatures(): void {
  void store.loadFeatures()
}

function reloadSuggestions(): void {
  void store.loadSuggestions()
}

/* ── 写操作 ── */

const confirmVisible = ref(false)
const canConfirm = computed(() => {
  const f = store.features
  return !!f && !f.empty && f.hotCount >= f.minHotSamples
})

async function submitConfirm(): Promise<boolean> {
  try {
    await store.confirmFeatures()
    Message.success('已确认：后续文案生成会带上这条偏好')
    confirmVisible.value = false
    return true
  } catch (e) {
    Message.error((e as Error).message)
    return false
  }
}

async function onCollect(): Promise<void> {
  try {
    const out = await store.collect()
    Message.info(out.windows.map((w) => w.message).join('；') || '已检查到期记录')
  } catch (e) {
    Message.error((e as Error).message)
  }
}

async function onRaise(row: ContentPerfRow): Promise<void> {
  if (!row.benchmark) return
  try {
    const r = await store.raiseBenchmarkPriority(row.benchmark.accountId)
    Message.success(r.capped ? `已在下限：每 ${r.to} 小时巡一次（不再降档）` : `监控间隔 ${r.from} → ${r.to} 小时`)
  } catch (e) {
    Message.error((e as Error).message)
  }
}

async function onConfirmSuggestion(s: Suggestion): Promise<void> {
  try {
    await store.confirmSuggestion(s.id)
    Message.success('已加入选题库；分配人物后可送入文案工坊')
  } catch (e) {
    Message.error((e as Error).message)
  }
}

async function onDismissSuggestion(s: Suggestion): Promise<void> {
  try {
    await store.dismissSuggestion(s.id)
    Message.success('已忽略该建议')
  } catch (e) {
    Message.error((e as Error).message)
  }
}

async function onRefreshSuggestions(): Promise<void> {
  try {
    const created = await store.refreshSuggestions()
    Message.info(created ? `新生成 ${created} 条建议` : '暂无新建议：需爆款样本达标且某维度占比 ≥ 60%')
  } catch (e) {
    Message.error((e as Error).message)
  }
}

/* ── CSV 导入 ── */

const importVisible = ref(false)
const resultVisible = ref(false)
const importPlatform = ref<Platform>('douyin')
const importWindow = ref<MetricWindow>('t1')
const importFile = ref<File | null>(null)
const importError = ref<string | null>(null)
const importResult = ref<ImportResult | null>(null)

const templateHeaders = computed(
  () => store.meta?.templates.find((t) => t.platform === importPlatform.value)?.headers.join(' / ') ?? '',
)

function openImport(): void {
  importFile.value = null
  importError.value = null
  importResult.value = null
  importVisible.value = true
}

function onPickFile(ev: Event): void {
  const input = ev.target as HTMLInputElement
  importFile.value = input.files?.[0] ?? null
  importError.value = null
}

async function submitImport(): Promise<boolean> {
  if (!importFile.value) {
    Message.warning('请先选择要导入的 CSV 文件')
    return false
  }
  importError.value = null
  try {
    const r = await store.importCsv({
      platform: importPlatform.value,
      window: importWindow.value,
      file: importFile.value,
    })
    importResult.value = r
    importVisible.value = false
    resultVisible.value = true
    Message.success(`导入完成：写入 ${r.imported} 条`)
    return true
  } catch (e) {
    importError.value = (e as Error).message
    return false
  }
}

async function onDownloadTemplate(): Promise<void> {
  try {
    await store.downloadTemplate(importPlatform.value)
  } catch (e) {
    Message.error((e as Error).message)
  }
}
</script>
