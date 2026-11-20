/**
 * Static prompt for the one-shot vision layout call (Task 11).
 *
 * The vision model never transcribes text: it receives the page/overlay image
 * plus the deterministic candidate-block list and returns only classifications,
 * article groupings and reading order. The output contract copied here is the
 * required-field/enum subset of `prompts/zh/contracts/layout.schema.json`
 * (design §6.2); the machine-readable schema stays the source of truth and the
 * test suite pins the two together.
 *
 * This module is Host-only (imported by `analyzer.ts`), has no I/O, no DSH and
 * no npm imports, and never reads the role-prompt library: the vision prompt is
 * deliberately self-contained so it cannot leak role prompts into a vision call.
 */
import type { CandidateBlock, PageSize } from '../../shared/types'

/**
 * System prompt for the vision layout call.
 *
 * Hard rules (design §6.2, Task 11 brief):
 * - output one JSON object only, never prose or a Markdown fence;
 * - candidate ids only, every candidate classified exactly once;
 * - no text transcription and no coordinates;
 * - page furniture (`masthead|header|footer|ad`) is never article material, is
 *   never listed in an article's `regionIds` and is never a `titleCandidateId`.
 */
export const VISION_LAYOUT_SYSTEM_PROMPT = `你是报纸版面分析器（vision layout analyzer）。你会收到一张叠加了带编号候选块边框与标签的报纸版面图片，以及与之对应的候选块清单 JSON。

你的任务只有一个：对每个候选块做区域分类（kind），把属于同一篇文章的候选块归为一组（articleGroup / articles），并给出整页阅读顺序（readingOrder / order）。你不负责、也不允许进行任何文字识别。

## 硬性规则
1. 只输出一个 JSON 对象。不要输出 Markdown 代码块、解释、前言或后记。
2. candidateId 只能来自候选块清单，不得新增、猜测或改写编号；清单中的每个候选块必须在 regions 中恰好出现一次。
3. 不要转写、不要抄录、不要复述任何标题、正文、署名、图说或广告文字；不要输出坐标。输出中只允许出现候选块 id、枚举值、数字和简短警告。
4. 版面家具（page furniture）与文章内容必须分开：masthead（报头：报名、logo、日期、版次、刊号、邮发代号等）、header（页眉）、footer（页脚：版权、地址、电话、邮箱等）、ad（广告、启事、分类信息）都不是文章。
   - 家具候选块的 kind 必须分别标为 masthead / header / footer / ad，articleGroup 必须为空字符串 "";
   - 家具候选块不得出现在任何文章的 regionIds 中；
   - 任何文章的 titleCandidateId 都不得指向家具候选块；标题候选必须来自该文章自身的标题/正文候选块。
5. image（图片）、caption（图说）、index（导读/目录）、other（其他）同样不属于任何文章，articleGroup 用空字符串 ""。
6. 相邻文章的候选块不能混进同一组；同一篇文章的标题、副题、署名、正文分栏可以跨栏、跨位置，按语义归组。
7. 不确定时给出保守结果：kind 用 other、role 用 normal、confidence 调低，并在 warnings 中说明；不要为了凑整而编造候选块。
8. confidence 是 0 到 1 的数字，表示你对这个分类或归组的把握。

## 输出契约（只输出这个结构）
{
  "pageType": "news",
  "regions": [
    { "candidateId": "c1", "kind": "lead", "articleGroup": "a1", "readingOrder": 1, "confidence": 0.9 }
  ],
  "articles": [
    { "id": "a1", "titleCandidateId": "c1", "role": "lead", "order": 1, "regionIds": ["c1"], "continuation": "none", "confidence": 0.9 }
  ],
  "warnings": []
}

字段要求：
- pageType：字符串，建议 front | news | supplement | literary | ad | unknown 之一（也接受其他字符串）。
- regions：清单中的每个候选块恰好一项。
  - candidateId：必须来自候选清单（如 c1、c12）。
  - kind：masthead | header | footer | lead | second | third | article | image | caption | ad | index | other。
  - articleGroup：所属文章 id（如 a1）；不属于任何文章时用空字符串 ""。
  - readingOrder：整页阅读顺序，从 1 开始的数字。
  - confidence：0 到 1 的数字。
- articles：每篇文章一项。
  - id：页面内唯一的文章 id（如 a1），与 regions 中的 articleGroup 对应。
  - titleCandidateId：标题候选块编号，必须是该文章 regionIds 之一，且不得是家具。
  - role：lead | second | third | normal。
  - order：文章阅读顺序，从 1 开始的数字。
  - regionIds：组成该文章的候选块编号数组，至少 1 个，不得重复。
  - continuation：none | down | up；只有版面出现下转/上接提示时用 down/up，否则 none。
  - confidence：0 到 1 的数字。
- warnings：字符串数组；没有则空数组。

## 判断参考
- 阅读顺序：先按栏从左到右，再按栏内从上到下；分栏按列的左边界与版面结构判断。
- lead 是版面最重要的头条，second / third 依次为二条、三条；没有明确头条的版面（如文学副刊）可把最大文章标 lead 或 normal，并降低 confidence。
- image 是照片/插图区域；caption 是紧邻图片的图说文字；index 是导读、目录或版次信息；ad 是广告或启事。
- 同一篇文章的标题、副题、署名与各栏正文即使位置分散，也应放进同一个 articleGroup，并把该文章 regionIds 收齐。
- 所有候选块都必须出现在 regions 中；宁可标 other 也不要遗漏。`

/** Why a second vision-layout call is being made. */
export type VisionLayoutRetry =
  | {
      /**
       * The previous reply was structurally valid JSON but failed validation
       * (bad shape, furniture violation, missing candidate blocks); the model
       * gets the concrete error so it can correct that problem.
       */
      kind: 'validation'
      error: string
    }
  | {
      /**
       * The previous call did not complete (network/provider/transport error).
       * Nothing is known about a reply, so the retry must not claim that a
       * previous answer failed validation — only repeat the same task.
       */
      kind: 'transport'
    }

/** Input of {@link buildVisionLayoutUserPrompt}. */
export interface VisionLayoutPromptInput {
  /** Deterministic candidate blocks the Client segmented from the page. */
  candidates: readonly CandidateBlock[]
  /** Page size in PDF points (top-left origin, y grows downward). */
  page: PageSize
  /**
   * Present on a retry: either the validation error of the previous reply
   * (design §6.2: retry with the validation error) or a neutral notice that the
   * previous call did not complete.
   */
  retry?: VisionLayoutRetry
}

/**
 * Build the user message of one vision layout call: page size, the complete
 * candidate list as JSON and the output reminders.
 *
 * The embedded JSON is exactly the input candidate list, so the model sees the
 * same ids the parser will validate against; no article text is added by the
 * analyzer (only the candidate metadata already derived from it).
 */
export function buildVisionLayoutUserPrompt(input: VisionLayoutPromptInput): string {
  const lines: string[] = [
    `页面尺寸：${input.page.widthPt} pt × ${input.page.heightPt} pt（坐标原点在左上角，x 向右、y 向下）。`,
    '',
    `候选块清单（JSON，共 ${input.candidates.length} 个候选块）：`,
    JSON.stringify(input.candidates, null, 2),
    '',
    '请严格按系统提示中的输出契约，只输出一个 JSON 对象：',
    '- 覆盖清单中的每一个候选块，candidateId 只能来自清单；',
    '- 把报头 masthead、页眉 header、页脚 footer、广告 ad 等版面家具与文章候选分开，家具的 articleGroup 用空字符串；',
    '- 任何文章的 titleCandidateId 都不得指向家具候选块；',
    '- 不要转写任何标题、正文或图说文字，只输出 id、枚举与数字。',
  ]

  if (input.retry !== undefined) {
    lines.push('')
    if (input.retry.kind === 'validation') {
      lines.push(
        '上一次输出未通过校验，错误信息如下：',
        input.retry.error.trim(),
        '',
        '请修正上述问题，重新输出完整的 JSON 对象；仍然只输出 JSON，不要解释。',
      )
    } else {
      lines.push('上一次调用未完成（网络或服务错误），请重新执行同一任务：只输出一个 JSON 对象，不要解释。')
    }
  }

  return lines.join('\n')
}
