# Architecture and source provenance

Loom's management/runtime separation was informed by odt/team-agent at 444bc40a:
`RuntimeAdapter`, `OnvoClawRuntimeAdapter`, and `memory_bridge.py`.
No root license was found in the inspected checkout. No Team Agent implementation
has been copied; the local TypeScript services are independently implemented.

DeepSeek Harness 0.1.0-rc.7 is used as an installed dependency, under its MIT
license in `node_modules/@deepseek-ai/dsh/LICENSE`. The supported Loom preset
is derived at startup from its bundled standard preset. Dependency files are
never modified by the new startup path. Its license and attribution remain
with the installed package and must accompany any redistributed bundle.

React, Vite and other installed libraries retain their respective package
licenses. LangGraph and OnvoClaw are not bundled or used as a second runtime.

The September 18 interaction/runtime review also used these public projects as
design references only:

- OpenAI Codex (`openai/codex`, Apache-2.0): durable agent events and explicit
  execution state.
- Cline (`cline/cline`, Apache-2.0): Plan/Act separation, review checkpoints,
  and human approval UX.
- Kit (`speakeasy-api/kit`, MIT): bounded subagent handoffs and reducing repeated
  context/tool round trips.

No source from those repositories is copied into Loom. Loom continues to use
DeepSeek Harness APIs and projections for the actual implementation.
