import { h, ref } from 'vue'
import { Input, Message, Modal } from '@arco-design/web-vue'

/**
 * 单行文本输入弹窗（驳回原因、撤销原因、重命名）。
 * 取消返回 null；required 时空值不关闭弹窗。
 */
export function promptText(opts: {
  title: string
  placeholder?: string
  initial?: string
  maxLength?: number
  required?: boolean
  okText?: string
}): Promise<string | null> {
  const value = ref(opts.initial ?? '')
  return new Promise((resolve) => {
    Modal.open({
      title: opts.title,
      okText: opts.okText ?? '确定',
      content: () =>
        h(Input, {
          modelValue: value.value,
          'onUpdate:modelValue': (v: string) => (value.value = v),
          placeholder: opts.placeholder,
          maxLength: opts.maxLength ?? 120,
          showWordLimit: true,
          autofocus: true,
        }),
      onBeforeOk: (done: (closed: boolean) => void) => {
        if (opts.required && !value.value.trim()) {
          Message.warning(`请填写${opts.placeholder ?? '内容'}`)
          done(false)
          return
        }
        done(true)
      },
      onOk: () => resolve(value.value.trim()),
      onCancel: () => resolve(null),
    })
  })
}

export function confirmAction(title: string, content: string, okText = '确定'): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title,
      content,
      okText,
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    })
  })
}
