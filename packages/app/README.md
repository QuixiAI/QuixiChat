# @quixi/app

One shared UI for web and desktop. `mountApp` currently displays only the scaffold
status. Product workflows and worker lifecycle will live in `src/runtime/`;
feature UI will live in `src/features/` (library, conversation, imports, search,
compatibility, settings). Shared presentation belongs in `src/components/` and
appearance in `src/themes/` when those implementations begin.

Hosts inject their platform capabilities. Components never open SQLite or depend
on Tauri directly. No product UI framework has been selected yet.
