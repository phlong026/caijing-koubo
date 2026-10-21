<template>
  <div class="source-intake">
    <div class="intake-tabs" role="tablist" aria-label="文案来源">
      <button v-for="item in TABS" :id="`source-tab-${item.key}`" :key="item.key" role="tab" :aria-selected="tab===item.key" :aria-controls="`source-pane-${item.key}`" :tabindex="tab===item.key?0:-1" :disabled="creating" @click="selectTab(item.key)" @keydown.right.prevent="moveTab(1)" @keydown.left.prevent="moveTab(-1)">{{ item.label }}</button>
    </div>
    <div class="source-shortcuts" aria-label="来源快捷入口">
      <button @click="shortcut('word')"><icon-file />Word 文档</button><button @click="shortcut('markdown')"><icon-file />Markdown</button><button @click="shortcut('paste')"><icon-paste />粘贴文本</button><button @click="selectTab('video')"><icon-video-camera />视频链接</button>
    </div>

    <div v-show="tab==='topics'" id="source-pane-topics" role="tabpanel" aria-labelledby="source-tab-topics">
      <slot v-if="hasTopicSource" />
      <p v-else class="intake-hint">从爆款选题中选择资讯或对标视频，送入这里继续创作。</p>
      <div class="intake-footer"><a-button @click="router.push('/topics')">选择爆款选题 <icon-arrow-right /></a-button></div>
    </div>

    <div v-show="tab==='article'" id="source-pane-article" role="tabpanel" aria-labelledby="source-tab-article">
      <div class="intake-row"><a-radio-group v-model="articleMode" type="button" size="small" :disabled="parsing||creating"><a-radio value="file">上传文章</a-radio><a-radio value="paste">粘贴文章</a-radio></a-radio-group></div>
      <div v-if="articleMode==='file'" class="article-upload">
        <a-upload :auto-upload="false" :limit="1" :accept="fileAccept" :file-list="fileList" :disabled="parsing||creating" @change="onFileChange" @before-remove="removeFile"><template #upload-button><a-button :loading="parsing"><icon-upload />选择文章文件</a-button></template></a-upload>
        <p class="intake-hint">支持 Word、PDF、TXT、Markdown；文件不超过 10MB，正文不超过 2 万字。</p>
      </div>
      <div v-else class="intake-field"><label for="source-article-text">来源文案</label><a-textarea id="source-article-text" v-model="articleText" aria-label="文章来源文案" :max-length="20000" show-word-limit :auto-size="{minRows:6,maxRows:14}" placeholder="粘贴文章、资讯、产品资料等完整正文，保留原有段落。" :disabled="parsing||creating" @input="parsed=null" /></div>
      <div class="intake-footer"><a-button :loading="parsing" :disabled="creating || (articleMode==='file'?!articleFile:!articleText.trim())" @click="parseArticle">解析并预览</a-button></div>
      <div v-if="parsed" class="article-outline">
        <div class="outline-heading"><strong>文章大纲</strong><span>{{ parsed.wordCount }} 字 · {{ parsed.outline.length }} 个节点</span></div>
        <ol><li v-for="node in parsed.outline" :key="node.index" :style="{marginLeft:`${Math.max(0,node.level-1)*16}px`}"><span>{{ node.title }}</span><small>{{ node.paragraphs }} 段 · {{ node.chars }} 字</small></li></ol>
        <details v-if="articlePreview"><summary>查看解析后的全文</summary><p>{{ articlePreview }}</p></details>
        <div class="intake-field"><label for="source-article-title">文案标题</label><a-input id="source-article-title" v-model="articleTitle" aria-label="文章文案标题" :max-length="60" show-word-limit placeholder="为这次创作填写标题" /></div>
      </div>
    </div>

    <div v-show="tab==='video'" id="source-pane-video" role="tabpanel" aria-labelledby="source-tab-video">
      <div class="intake-field"><label for="source-video-url">视频分享链接</label><a-input id="source-video-url" v-model="videoLink" aria-label="视频分享链接" allow-clear placeholder="粘贴抖音视频链接或分享口令" :disabled="parsingVideo||creating" /></div>
      <div class="intake-footer"><span class="intake-hint">已有提取结果会直接复用。</span><a-button :loading="parsingVideo" :disabled="!videoLink.trim()||creating" @click="parseVideo">解析并提取文案</a-button></div>
      <div v-if="video" class="video-intake-result">
        <div class="video-intake-card"><BenchmarkVideoCard :video="video" :active="tab==='video'" @detail="showScript" @extract="retryExtract" @send="showScript" /></div>
        <div class="video-intake-text"><strong>{{ extractionLabel }}</strong><p v-if="extractError" role="alert" class="intake-error">{{ extractError }}</p><p v-if="pollStopped" class="intake-hint">提取仍可能在进行中，可继续查看进度。</p><a-button v-if="pollStopped" size="small" @click="resumePoll">继续查看进度</a-button><p v-if="video.extractStatus==='uncertain'" class="intake-hint">上次提取结果不确定，重新提取可能重复计费。</p><a-button v-if="['failed','uncertain'].includes(video.extractStatus)" :loading="retrying" @click="retryExtract">{{ video.extractStatus==='uncertain'?'确认后重新提取':'重新提取' }}</a-button><pre v-if="scriptText">{{ scriptText }}</pre><p v-else class="intake-hint">提取完成后，可核对文案并选择目标人物。</p></div>
      </div>
    </div>

    <div v-show="tab==='manual'" id="source-pane-manual" role="tabpanel" aria-labelledby="source-tab-manual">
      <div class="intake-field"><label for="source-manual-title">文案标题 <span>必填</span></label><a-input id="source-manual-title" v-model="manual.title" aria-label="手动文案标题" :max-length="60" show-word-limit placeholder="例如：为什么理财知识听懂了却记不住？" :disabled="creating" /></div>
      <div class="intake-field"><label for="source-manual-text">来源文案 / 补充资料 <span>可选</span></label><a-textarea id="source-manual-text" v-model="manual.text" aria-label="手动来源文案" :max-length="5000" show-word-limit :auto-size="{minRows:6,maxRows:14}" placeholder="粘贴已有文案、资讯摘要、产品资料或创作要点，作为本次写作的依据；没有资料也可按标题起草。" :disabled="creating" /></div>
      <div class="intake-field"><label for="source-manual-keywords">关键词 / 要点 <span>可选</span></label><a-input id="source-manual-keywords" v-model="manual.keywords" aria-label="关键词或要点" :max-length="200" placeholder="例如：理财初学者、知识框架、学习方法" :disabled="creating" /></div>
    </div>

    <div v-if="tab==='manual'||(tab==='article'&&parsed)||(tab==='video'&&video?.extractStatus==='done')" class="intake-create">
      <label for="source-personas">目标人物</label><a-select id="source-personas" v-model="personaIds" aria-label="来源目标人物" multiple placeholder="选择一位或多位人物" :disabled="creating"><a-option v-for="p in personas" :key="p.id" :value="p.id" :label="p.name" /></a-select>
      <div class="intake-footer"><span class="intake-hint">为每位人物新建一条文案，保留当前稿件。</span><a-button type="primary" :loading="creating" :disabled="!canCreate" @click="createFromSource">创建文案并继续</a-button></div>
    </div>
    <p v-if="error" role="alert" class="intake-error">{{ error }}</p>
    <details v-if="store.copy && !(tab==='topics'&&hasTopicSource)" class="current-material"><summary>查看当前任务素材 · {{ store.copy.sourceLabel }}</summary><slot /></details>
  </div>
</template>

<script setup lang="ts">
import {computed,nextTick,onBeforeUnmount,reactive,ref,watch} from 'vue'
import {Message,Modal,type FileItem} from '@arco-design/web-vue'
import {useRouter} from 'vue-router'
import {useCopyStore} from '@/stores/copy'
import {ApiError} from '@/api/client'
import {articleApi,copyApi,type ArticleCreated} from '@/api/copy'
import {parseBenchmarkLink,getExtractStatus,getVideoScript,extractVideo,sendVideoToCopy,type BenchVideo} from '@/api/benchmark'
import BenchmarkVideoCard from '@/views/topics/BenchmarkVideoCard.vue'
const emit=defineEmits<{(e:'created',ids:string[]):void;(e:'source-mode',mode:string):void}>()
const store=useCopyStore(),router=useRouter()
type SourceTab='topics'|'article'|'video'|'manual'
const TABS:[{key:SourceTab;label:string},{key:SourceTab;label:string},{key:SourceTab;label:string},{key:SourceTab;label:string}]=[{key:'topics',label:'爆款选题'},{key:'article',label:'文章'},{key:'video',label:'视频改写'},{key:'manual',label:'手动输入'}]
const tab=ref<SourceTab>('topics'),articleMode=ref<'file'|'paste'>('file'),fileAccept=ref('.docx,.pdf,.txt,.md')
const manual=reactive({title:'',text:'',keywords:''}),personaIds=ref<string[]>([]),error=ref(''),creating=ref(false)
const articleText=ref(''),articleTitle=ref(''),articleFile=ref<File|null>(null),fileList=ref<FileItem[]>([]),parsed=ref<ArticleCreated|null>(null),articlePreview=ref(''),parsing=ref(false)
const videoLink=ref(''),video=ref<BenchVideo|null>(null),scriptText=ref(''),parsingVideo=ref(false),retrying=ref(false),extractError=ref(''),pollStopped=ref(false)
let pollTimer:ReturnType<typeof setTimeout>|null=null,videoSeq=0,pollStarted=0
const personas=computed(()=>store.options?.personas.filter(p=>p.enabled) ?? [])
const hasTopicSource=computed(()=>['news','benchmark'].includes(store.copy?.source ?? ''))
const canCreate=computed(()=>!creating.value && !parsing.value && personaIds.value.length>0 && (tab.value==='manual'?!!manual.title.trim():tab.value==='article'?!!parsed.value && !!articleTitle.value.trim():tab.value==='video' && video.value?.extractStatus==='done'))
const extractionLabel=computed(()=>({none:'等待提取',pending:'等待提取',submitting:'正在提取',running:'正在提取',done:'文案已提取，可创建文案',failed:'提取失败',uncertain:'需要确认后重试'}[video.value?.extractStatus ?? 'none']))
watch(()=>store.copy?.id,()=>{tab.value=store.copy?.source==='article'?'article':store.copy?.source==='manual'?'manual':'topics';const pid=store.detail?.persona?.id;personaIds.value=pid&&personas.value.some(p=>p.id===pid)?[pid]:[];error.value='';creating.value=false;stopPoll();videoSeq++;parsingVideo.value=false;video.value=null;scriptText.value=''}, {immediate:true})
watch(tab,value=>emit('source-mode',value),{immediate:true})
function selectTab(value:SourceTab){if(creating.value)return;if(value==='article')fileAccept.value='.docx,.pdf,.txt,.md';tab.value=value;error.value=''}
async function moveTab(offset:number){const index=TABS.findIndex(t=>t.key===tab.value);selectTab(TABS[(index+offset+TABS.length)%TABS.length].key);await nextTick();document.getElementById(`source-tab-${tab.value}`)?.focus()}
async function shortcut(kind:'word'|'markdown'|'paste'){if(parsing.value||creating.value)return;selectTab('article');articleMode.value=kind==='paste'?'paste':'file';fileAccept.value=kind==='word'?'.docx':kind==='markdown'?'.md':'.docx,.pdf,.txt,.md';await nextTick();if(kind==='paste')document.querySelector<HTMLTextAreaElement>('#source-article-text textarea')?.focus()}
function onFileChange(files:FileItem[],current:FileItem){fileList.value=files;articleFile.value=current.file ?? null;parsed.value=null;error.value=''}
async function removeFile(){fileList.value=[];articleFile.value=null;parsed.value=null;return true}
async function parseArticle(){
  error.value='';parsed.value=null;parsing.value=true
  try{
    if(articleMode.value==='file'){
      if(!articleFile.value)throw new Error('请选择文章文件')
      if(articleFile.value.size>10*1024*1024)throw new Error('文件超过10MB，请拆分后上传')
    }else if(!articleText.value.trim())throw new Error('请粘贴来源文案')
    const result=articleMode.value==='file'?await articleApi.uploadEdit(articleFile.value!):await articleApi.uploadText(articleText.value)
    const detail=await articleApi.detail(result.articleId)
    parsed.value=result;articlePreview.value=detail.plainText
    articleTitle.value=(result.outline.find(n=>n.title)?.title || articleFile.value?.name.replace(/\.[^.]+$/,'') || '文章口播').replace(/^#{1,6}\s+/,'').slice(0,60)
  }catch(e){error.value=(e as Error).message}finally{parsing.value=false}
}
async function saveCurrent(){
  if(!(await store.saveCreativeSettings()))throw new Error(store.settingsError || '请先保存创作设置')
  if(store.isDirty && await store.save()!=='ok')throw new Error(store.error || '请先保存当前稿件')
}
async function createFromSource(){
  if(!canCreate.value)return
  creating.value=true;error.value='';let created=false
  try{
    await saveCurrent()
    const result=tab.value==='video'?await sendVideoToCopy(video.value!.id,personaIds.value):await copyApi.create({source:tab.value==='article'?'article':'manual',personaIds:personaIds.value,title:tab.value==='article'?articleTitle.value.trim():manual.title.trim(),articleId:tab.value==='article'?parsed.value!.articleId:undefined,sourceText:tab.value==='manual'?manual.text.trim()||undefined:undefined,keywords:tab.value==='manual'?manual.keywords.trim()||undefined:undefined})
    created=true;emit('created',result.copyIds);Message.success(`已创建 ${result.copyIds.length} 条文案`)
  }catch(e){error.value=(e as Error).message}finally{if(!created)creating.value=false}
}
function stopPoll(){if(pollTimer)clearTimeout(pollTimer);pollTimer=null}
async function showScript(){if(!video.value)return;if(video.value.extractStatus!=='done'){Message.info('提取完成后可查看文案');return}const id=video.value.id,seq=videoSeq;try{const result=await getVideoScript(id);if(seq===videoSeq&&video.value?.id===id)scriptText.value=result.text}catch(e){extractError.value=(e as Error).message}}
async function poll(seq:number){
  const id=video.value?.id;if(!id||seq!==videoSeq)return
  try{
    const result=await getExtractStatus(id);if(seq!==videoSeq||video.value?.id!==id)return
    video.value={...video.value,extractStatus:result.status};extractError.value=result.error || ''
    if(result.status==='done'){await showScript();return}
    if(['failed','uncertain'].includes(result.status))return
    if(Date.now()-pollStarted>600000){pollStopped.value=true;return}
    pollTimer=setTimeout(()=>void poll(seq),1800)
  }catch(e){if(seq===videoSeq){extractError.value=(e as Error).message;pollStopped.value=true}}
}
function resumePoll(){stopPoll();pollStarted=Date.now();pollStopped.value=false;void poll(videoSeq)}
async function parseVideo(){
  if(!videoLink.value.trim()||parsingVideo.value)return
  stopPoll();const seq=++videoSeq;parsingVideo.value=true;video.value=null;scriptText.value='';error.value='';extractError.value=''
  try{const result=await parseBenchmarkLink(videoLink.value.trim());if(seq!==videoSeq)return;video.value={...result.video,extractStatus:result.extractStatus as BenchVideo['extractStatus']};resumePoll()}catch(e){if(seq===videoSeq)error.value=e instanceof ApiError&&e.code==='domain_not_allowed'?'暂不支持该链接，请使用抖音视频分享链接':(e as Error).message}finally{if(seq===videoSeq)parsingVideo.value=false}
}
async function retryExtract(){
  if(!video.value||retrying.value)return
  if(video.value.extractStatus==='done'){await showScript();return}
  if(['pending','submitting','running'].includes(video.value.extractStatus)){resumePoll();return}
  const confirmed=video.value.extractStatus!=='uncertain'||await new Promise<boolean>(resolve=>Modal.confirm({title:'确认重新提取？',content:'上一次提取结果不确定，可能已产生费用。重新提取可能重复计费。',okText:'确认重新提取',cancelText:'取消',onOk:()=>resolve(true),onCancel:()=>resolve(false)}))
  if(!confirmed)return
  const id=video.value.id,seq=videoSeq;retrying.value=true
  try{await extractVideo(id,video.value.extractStatus==='uncertain');if(seq===videoSeq&&video.value?.id===id){video.value={...video.value,extractStatus:'pending'};resumePoll()}}catch(e){extractError.value=(e as Error).message}finally{retrying.value=false}
}
watch(articleMode,()=>{parsed.value=null;articlePreview.value=''})
onBeforeUnmount(()=>{stopPoll();videoSeq++})
</script>

<style scoped>
.intake-tabs{display:flex;gap:24px;border-bottom:1px solid var(--mw-border);margin-bottom:18px;flex-wrap:wrap}.intake-tabs button{font:inherit;font-size:14px;padding:0 2px 12px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--mw-text3);cursor:pointer}.intake-tabs button[aria-selected=true]{color:var(--mw-primary);font-weight:600;border-bottom-color:var(--mw-primary)}.source-shortcuts{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:24px}.source-shortcuts button{display:flex;align-items:center;gap:7px;padding:8px 12px;border:1px solid var(--mw-border);background:#fafbf9;border-radius:5px;font-size:12px;color:var(--mw-text2);cursor:pointer}.source-shortcuts button:hover{border-color:var(--mw-primary);color:var(--mw-primary)}.intake-row{margin-bottom:18px}.intake-field{margin-bottom:20px}.intake-field>label,.intake-create>label{display:block;font-size:13px;color:var(--mw-text2);margin-bottom:9px}.intake-field>label span{color:var(--mw-text3);font-size:12px;margin-left:6px}.intake-footer{display:flex;align-items:center;justify-content:flex-end;gap:16px;flex-wrap:wrap;margin-top:16px}.intake-footer>.intake-hint{flex:1}.intake-hint{font-size:12px;color:var(--mw-text3);line-height:1.8;margin:8px 0}.intake-error{font-size:13px;color:#b45f34;line-height:1.8;margin-top:14px}.intake-create{margin-top:24px;padding-top:20px;border-top:1px solid var(--mw-border-light)}.article-outline{margin-top:22px;padding:18px;background:#f7f9f6;border:1px solid var(--mw-border-light);border-radius:6px}.outline-heading{display:flex;justify-content:space-between;gap:12px;font-size:13px}.outline-heading span{font-size:12px;color:var(--mw-text3)}.article-outline ol{list-style:none;padding:0;margin:16px 0}.article-outline li{display:flex;justify-content:space-between;gap:12px;padding:8px 0;font-size:13px;border-bottom:1px solid var(--mw-border-light)}.article-outline li small{white-space:nowrap;color:var(--mw-text3)}.article-outline details{margin:16px 0;font-size:12px;line-height:1.8}.article-outline details p{white-space:pre-wrap;margin-top:12px}.article-outline summary,.current-material summary{cursor:pointer;color:var(--mw-primary)}.current-material{margin-top:24px;padding-top:18px;border-top:1px solid var(--mw-border-light);font-size:12px}.current-material[open]>summary{margin-bottom:18px}.video-intake-result{display:grid;grid-template-columns:minmax(210px,280px) minmax(0,1fr);gap:24px;margin-top:24px}.video-intake-text{font-size:13px;min-width:0}.video-intake-text pre{font:inherit;white-space:pre-wrap;line-height:1.9;margin-top:16px;max-height:460px;overflow:auto}.video-intake-card{min-width:0}.article-upload{padding:18px;border:1px dashed #cbd4cf;border-radius:6px;background:#fcfdfb}@media(max-width:650px){.intake-tabs{gap:16px}.source-shortcuts{display:grid;grid-template-columns:1fr 1fr}.source-shortcuts button{padding:8px;justify-content:center}.intake-footer>.arco-btn{width:100%}.video-intake-result{grid-template-columns:1fr}.outline-heading,.article-outline li{flex-wrap:wrap}}
</style>
<style scoped>
.video-intake-card :deep(.benchmark-card-metrics),.video-intake-card :deep(.benchmark-performance),.video-intake-card :deep(.benchmark-card-actions),.video-intake-card :deep(.benchmark-topic-tags){display:none}.video-intake-card :deep(.benchmark-card-body){padding-bottom:16px}
@media(max-width:650px){.intake-tabs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 12px}.intake-tabs button{padding:10px 0;text-align:center}}
</style>
