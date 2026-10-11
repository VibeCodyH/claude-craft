import { describe, expect, test } from 'claude-code/testing'

const reply = [
  'Ideas that fit:',
  '',
  '1. **Prod tripwire:** a red band while `neonctl` runs.',
  '2. **Clipboard step tracker:** the one-step flow.',
  '',
  '```sh',
  'echo **not a title**',
  '```',
].join('\n')

describe('yellow-titles', () => {
  test('bold spans are yellow, code stays in a Markdown block, list markers kept', async $ => {
    const ui = await $.ui.mount({
      plugin: 'yellow-titles',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { text: reply, isFirstOfReply: true },
    } as never)

    const title = await ui.find({ type: 'Text', text: /^Prod tripwire:$/ })
    expect(title?.props.color).toBe('yellow')
    expect(title?.props.bold).toBe(true)

    const code = await ui.find({ type: 'Text', text: /^neonctl$/ })
    expect(code?.props.color).toBe('blueBright')

    expect(await ui.find({ type: 'Text', text: /^1\. $/ })).toBeDefined()

    const blocks = await ui.findAll({ type: 'Markdown' })
    expect(blocks.some(b => String(b.props.text).includes('echo **not a title**'))).toBe(true)
    expect(await ui.find({ type: 'Text', text: /^not a title$/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a reply with no bold is left to the engine', async ($, on) => {
    // Stands in for the engine's own drawing beneath the plugin.
    on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return Text({ key: 'engine', children: 'ENGINE' })
    })
    const ui = await $.ui.mount({
      plugin: 'yellow-titles',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { text: 'Plain answer, nothing to color.', isFirstOfReply: true },
    } as never)
    expect(await ui.find({ type: 'Text', text: /^ENGINE$/ })).toBeDefined()
    await ui.unmount()
  })
})
