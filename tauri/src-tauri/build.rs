fn main() {
    // WinDivert.dll を最初の呼び出し時に読み込む
    println!("cargo:rustc-link-arg-bins=/DELAYLOAD:WinDivert.dll");
    println!("cargo:rustc-link-arg-bins=delayimp.lib");

    let windows_attrs = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("app.manifest"));
    let attrs = tauri_build::Attributes::new().windows_attributes(windows_attrs);
    tauri_build::try_build(attrs).expect("failed to run tauri-build");
}
