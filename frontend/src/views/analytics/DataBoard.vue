<template>
  <div class="p-7 pb-10 max-w-[1440px] mx-auto">
    <PageHead title="数据看板">
      <template #sub>从内容表现，找到下一轮选题线索</template>
    </PageHead>

    <!-- 回采数据层（metric_snapshot）落地前以空态占位；不展示任何未经回采的数字 -->
    <div class="mw-card p-12 flex flex-col items-center justify-center text-center gap-3">
      <icon-bar-chart :size="40" class="text-[var(--mw-text3)]" />
      <div class="text-[16px] font-semibold mt-1">数据看板建设中</div>
      <div class="mw-subtle max-w-[440px] leading-6">
        内容表现回采（T+1 / T+7 独立快照）、爆款特征沉淀与选题反馈能力将随二期上线。
        发布首批内容并导入 CSV 回采数据后，这里将展示真实的播放、互动与爆款统计。
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import PageHead from '@/components/PageHead.vue'
</script>
