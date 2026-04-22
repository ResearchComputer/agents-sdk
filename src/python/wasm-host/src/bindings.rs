//! Types generated from `src/python/wit/world.wit` at compile time.

wasmtime::component::bindgen!({
    path: "../wit/world.wit",
    world: "flash-agent-core",
    imports: { default: async | trappable },
    exports: { default: async },
    with: {
        // Map the host-owned `llm-stream` resource onto our Rust type.
        "research-computer:flash-agents/host-llm.llm-stream": crate::host_llm::HostLlmStream,
    },
});
