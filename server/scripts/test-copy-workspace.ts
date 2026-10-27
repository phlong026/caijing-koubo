import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
const temp=mkdtempSync(join(tmpdir(),'copy-workspace-'))
Object.assign(process.env,{DB_DRIVER:'sqlite',DB_SQLITE_PATH:join(temp,'test.db'),TEMP_DIR:join(temp,'uploads'),LOG_LEVEL:'silent',REVIEW_STUB_ENABLED:'false'})
const {initDb,closeAll}=await import('../src/db/index.js')
const {runMigrations}=await import('../src/db/migrate.js')
const {buildApp}=await import('../src/app.js')
const {getRedis}=await import('../src/queue/index.js')
const db=await initDb();await runMigrations();const app=await buildApp()
let passed=0
async function req(method:string,path:string,body?:unknown,status=200){const r=await app.inject({method:method as any,url:'/api'+path,headers:{'x-operator':'workspace-regression'},...(body===undefined?{}:{payload:body as any})});assert.equal(r.statusCode,status,r.body);return r.json().data}
function pass(name:string){passed++;console.log('PASS '+name)}
try{
 const {toPlainText,contentHash}=await import('../src/modules/copy/text.js')
 const {mapDraft,mapVersion}=await import('../src/modules/copy/repo.js')
 const prose=[{label:'开场',text:'  先聊聊学习方法。 '},{label:'01 中间',text:'第一，理解基础。第二，反复练习。'},{label:'收尾',text:'慢慢来，也能学扎实。'},{label:'空段',text:' '}]
 const body='先聊聊学习方法。\n\n第一，理解基础。第二，反复练习。\n\n慢慢来，也能学扎实。'
 const clean='知识学习\n\n'+body
 assert.equal(toPlainText('知识学习',prose),clean);assert.equal(toPlainText(null,prose),body)
 const legacy={id:'legacy',title:'知识学习',sections:JSON.stringify(prose),plain_text:'开场\n旧格式',content_hash:contentHash('知识学习',prose)}
 assert.equal(mapDraft(legacy).plainText,clean);assert.equal(mapVersion(legacy).plainText,clean);assert.equal(mapVersion(legacy).contentHash,legacy.content_hash)
 pass('plain manuscript omits structural labels; legacy draft/version reads preserve prose and final hashes')
 const options=await req('GET','/copy/options')
 const persona=options.personas.find((p:any)=>p.enabled&&p.line==='kos')
 assert.ok(persona)
 const template=options.templates.find((t:any)=>t.name.includes('市场'))??options.templates[0]
 const style=options.styles.find((s:any)=>s.line==='kos')
 const created=await req('POST','/copy',{source:'manual',personaIds:[persona.id],title:'工作区回归验证',sourceText:'原始素材：书名《钱图》，仅供转写核对。'})
 const id=created.copyIds[0];let detail=await req('GET',`/copy/${id}`);const draftId=detail.currentDraft.id
 const settings={templateId:template.id,styleId:style.id,durationTier:'medium',durationSeconds:null,count:2,instructions:'面向初学者，先讲误区，不编造数据。'}
 await req('PUT',`/copy/${id}/settings`,settings);detail=await req('GET',`/copy/${id}`)
 assert.equal(detail.copy.settings.instructions,settings.instructions);assert.equal(detail.copy.settings.count,2)
 const preview=await req('POST',`/copy/${id}/prompt-preview`,settings)
 assert.ok(preview.user.includes(template.name));assert.ok(preview.user.includes(settings.instructions));assert.equal(preview.candidates.length,2);assert.notEqual(preview.candidates[0].user,preview.candidates[1].user)
 assert.ok(preview.user.includes('text 直接输出可朗读的改写文案'))
 pass('settings persist; preview uses current inputs and distinct candidate directions')
 await req('PUT',`/copy/${id}/settings`,{...settings,count:99},400)
 await req('PUT',`/copy/${id}/settings`,{...settings,durationTier:'custom',durationSeconds:0},400)
 pass('invalid count and custom duration rejected')
 const source=await req('GET',`/copy/${id}/source`)
 await req('PUT',`/copy/${id}/source-review`,{correctedText:'已校对素材：书名《钱图》，介绍知识学习方法。',note:'事实尚待人工确认',confirmed:false})
 await req('PUT',`/copy/${id}/settings`,{...settings,count:1})
 assert.equal((await req('GET',`/copy/${id}/source`)).text,source.text)
 assert.ok((await req('POST',`/copy/${id}/prompt-preview`,settings)).user.includes('已校对素材'))
 assert.ok((await req('GET',`/copy/${id}`)).copy.settings.sourceReview)
 pass('corrected source feeds prompt; raw source and review survive setting updates')
 let draft=(await req('PUT',`/copy/${id}/drafts/${draftId}`,{title:'知识框架怎么搭',rev:detail.currentDraft.rev,sections:[{label:'正文',text:'第一，先理解基础概念。'+'系统学习可以帮助理解知识之间的联系。'.repeat(18)}]})).draft
 const check=await req('POST',`/copy/${id}/precheck`,{draftId})
 assert.ok(check.estSeconds>60);assert.equal(check.durationOk,false);assert.ok(check.checks.find((c:any)=>c.key==='duration'&&!c.pass));assert.ok(check.checks.find((c:any)=>c.key==='sourceReview'&&!c.pass));assert.equal(check.complianceHits.filter((h:any)=>h.word==='第一').length,0)
 assert.ok((await req('POST','/copy/compliance/scan',{sections:[{label:'正文',text:'我们就是行业第一。'}]})).hits.some((h:any)=>h.word==='第一'))
 pass('duration and facts warnings; ordinal exemption preserves superiority warnings')
 await req('POST',`/copy/${id}/finalize`,{draftId,rev:draft.rev-1},409)
 const final=await req('POST',`/copy/${id}/finalize`,{draftId,rev:draft.rev})
 assert.equal((await req('GET',`/copy/${id}`)).drafts.find((d:any)=>d.id===draftId).isFinal,true)
 const snapshot=await req('GET',`/copy/versions/${final.finalSelection.versionId}`)
 draft=(await req('PUT',`/copy/${id}/drafts/${draftId}`,{title:draft.title,rev:draft.rev,sections:[{label:'正文',text:'修改后的文案，必须重新定稿。'}]})).draft
 assert.equal((await req('GET',`/copy/${id}`)).drafts.find((d:any)=>d.id===draftId).isFinal,false)
 assert.ok((await req('POST',`/copy/${id}/precheck`,{draftId})).checks.some((c:any)=>c.key==='finalSelection'&&c.level==='hard'&&!c.pass))
 assert.equal((await req('GET',`/copy/versions/${final.finalSelection.versionId}`)).plainText,snapshot.plainText)
 pass('immutable final snapshot, stale revision rejection and final invalidation after edits')
 await db.run("UPDATE `copy` SET `status`='in_review' WHERE `id`=?",[id])
 await req('PUT',`/copy/${id}/settings`,settings,409)
 await req('PUT',`/copy/${id}/source-review`,{correctedText:'试图更改'},409)
 await req('POST',`/copy/${id}/finalize`,{draftId,rev:draft.rev},409)
 pass('review lock protects settings, source and final selection')
 const before=(await req('GET',`/copy/${id}`)).currentDraft
 const manualText='来源测试资料：学习计划需结合个人基础安排，不承诺学习或投资效果。'
 await req('POST','/copy',{source:'manual',personaIds:[persona.id],title:'',sourceText:manualText},400)
 const manualCopy=await req('POST','/copy',{source:'manual',personaIds:[persona.id],title:'手动来源验证',sourceText:manualText,keywords:'知识框架'})
 const manualDetail=await req('GET',`/copy/${manualCopy.copyIds[0]}`)
 assert.equal(manualDetail.copy.source,'manual');assert.equal(manualDetail.copy.sourceText,manualText)
 const topic=await db.get<any>('SELECT * FROM `topic` WHERE `id`=?',[manualCopy.topicId]);assert.equal(topic.source,'manual');assert.equal(topic.status,'sent')
 const manualPrompt=await req('POST',`/copy/${manualCopy.copyIds[0]}/prompt-preview`,settings)
 assert.ok(manualPrompt.user.includes('生成模式：手动创作'));assert.ok(manualPrompt.user.includes(manualText))
 pass('manual source requires title; creates its own task with source text and manual generation mode')
 const articleText='# 学习方法\n\n先搭建基础框架。\n\n## 复习安排\n\n再通过复习巩固知识。'
 const article=await req('POST','/articles',{text:articleText,filename:'来源验证.md'})
 assert.ok(article.outline.length>=2);assert.ok(article.wordCount>0)
 const articleData=await req('GET',`/articles/${article.articleId}`);assert.ok(articleData.plainText.includes('复习'))
 const articleCopies=await req('POST','/copy',{source:'article',personaIds:options.personas.filter((p:any)=>p.enabled).slice(0,2).map((p:any)=>p.id),title:'文章来源验证',articleId:article.articleId})
 assert.equal(articleCopies.copyIds.length,2)
 for(const createdId of articleCopies.copyIds){const d=await req('GET',`/copy/${createdId}`);assert.equal(d.copy.source,'article');assert.equal(d.copy.sourceText,articleData.plainText)}
 const articlePrompt=await req('POST',`/copy/${articleCopies.copyIds[0]}/prompt-preview`,settings)
 assert.ok(articlePrompt.user.includes('生成模式：文章转口播'));assert.ok(articlePrompt.user.includes('sourceRefs'));assert.ok(articlePrompt.user.includes('文章大纲'))
 assert.equal((await req('GET',`/copy/${id}`)).currentDraft.title,before.title)
 assert.deepEqual((await req('GET',`/copy/${id}`)).currentDraft.sections,before.sections)
 await req('POST','/articles',{text:'文'.repeat(20001)},413)
 await req('POST','/benchmark/parse-link',{shareUrl:'https://example.com/video/123'},400)
 pass('pasted article produces outline and per-person tasks; source modes, limits and original drafts preserved')
 const boundary='copy-source-markdown-boundary'
 const multipart=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="source.md"\r\nContent-Type: text/markdown\r\n\r\n${articleText}\r\n--${boundary}--\r\n`)
 const upload=await app.inject({method:'POST',url:'/api/articles',headers:{'content-type':`multipart/form-data; boundary=${boundary}`},payload:multipart})
 assert.equal(upload.statusCode,200,upload.body)
 const uploaded=upload.json().data
 assert.equal(uploaded.outline[0].level,1);assert.ok(uploaded.outline.some((n:any)=>n.level===2&&n.title==='复习安排'))
 pass('uploaded Markdown preserves heading levels and paragraph counts')
 console.log(`${passed} workspace regression groups passed`)
}finally{
 await app.close();getRedis().disconnect();await closeAll()
 if(!resolve(temp).startsWith(resolve(tmpdir())+sep))throw new Error('Unexpected test directory')
 rmSync(temp,{recursive:true,force:true})
}
