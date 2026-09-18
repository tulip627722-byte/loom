import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Supported preset extension, never writes into node_modules. The source preset
// is MIT-licensed by DeepSeek; see THIRD_PARTY.md.
export function preparePresets(repoRoot: string, dshHome: string, dataRoot: string) {
  const upstream = readFileSync(join(repoRoot,'node_modules/@deepseek-ai/dsh/config/agent-presets/standard/agent.cordis.yml'),'utf8');
  const plugin = resolve(repoRoot,'server/tulip-plugin.mjs');
  const bridge = (author: boolean) => `\n- id: tulip-bridge\n  name: ${JSON.stringify(plugin)}\n  config:\n    author: ${author}\n`;
  // Limit all native delegation paths: no nested delegation, at most two children
  // enforced again by the bridge guard. Optional external providers stay disabled.
  let standard = upstream.replaceAll('backgroundMode: continuable', 'backgroundMode: continuable\n        maxDepth: 1');
  standard = standard.replace("- id: skill-filesystem\n  name: '@deepseek-ai/dsh-skill-filesystem'", `- id: skill-filesystem\n  name: '@deepseek-ai/dsh-skill-filesystem'\n  config:\n    customSkillDirs:\n      - ${JSON.stringify(join(dataRoot,'skills'))}`);
  standard = standard.replace("    - id: tool-workflow\n      name:", "    - id: tool-workflow\n      disabled: true\n      name:").replace("    - id: tool-ralph\n      name:","    - id: tool-ralph\n      disabled: true\n      name:");
  const author = `- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: '你是 Tulip Skill 设计伙伴。先理解需求，通过 ask_user_question 询问关键选择。用 tulip_skill_draft 提交完整 Markdown 草稿供用户编辑确认。你不能安装 Skill、执行命令或写项目文件；保存安装由工作台的确认按钮完成。用户取消就停止。'\n- id: ask-user\n  name: '@deepseek-ai/dsh-tool-ask-user'\n- id: planning\n  name: cordis:group\n  group: true\n  isolate:\n    planMode: true\n  config:\n    - id: plan-mode\n      name: '@deepseek-ai/dsh-plan-mode'\n      config:\n        section: '先讨论 Skill 的用途和边界，使用选择题澄清，然后提交可编辑草稿。Skill 安装仅能通过工作台确认保存，不要要求用户批准执行代码。'\n`;
  for (const [id, content] of [['tulip-work',standard+bridge(false)],['tulip-skill-author',author+bridge(true)]]) {
    const dir=join(dshHome,'.agent-presets',id); mkdirSync(dir,{recursive:true});
    const target=join(dir,'agent.cordis.yml');
    if (existsSync(target) && readFileSync(target,'utf8') !== content) writeFileSync(`${target}.previous`,readFileSync(target),{mode:0o600});
    writeFileSync(target,content,{mode:0o600});
  }
}
