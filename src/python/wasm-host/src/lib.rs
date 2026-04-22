use pyo3::prelude::*;

mod agent;
mod bindings;
mod host_llm;
mod host_tools;
mod state;

#[pymodule]
fn flash_agents_wasm(_py: Python<'_>, m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("__version__", "0.1.0")?;
    m.add_class::<agent::Agent>()?;
    m.add_class::<agent::EventStream>()?;
    Ok(())
}
