use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn optimize(modules_json: &str, request_json: &str) -> Result<String, JsError> {
    let modules: Vec<star_optimizer::ModuleInput> = serde_json::from_str(modules_json)
        .map_err(|e| JsError::new(&format!("modules parse error: {e}")))?;
    let req: star_optimizer::OptimizeRequest = serde_json::from_str(request_json)
        .map_err(|e| JsError::new(&format!("request parse error: {e}")))?;
    let result = star_optimizer::optimize(&modules, &req);
    serde_json::to_string(&result)
        .map_err(|e| JsError::new(&format!("serialize error: {e}")))
}
