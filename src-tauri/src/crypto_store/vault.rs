use std::path::Path;

use zeroize::Zeroizing;

pub(super) type Key = Zeroizing<[u8; 32]>;

fn decode(bytes: Vec<u8>) -> Result<Key, String> {
    let bytes = Zeroizing::new(bytes);
    let mut key = Zeroizing::new([0; 32]);
    if bytes.len() != key.len() {
        return Err("The local Matrix store key is invalid.".into());
    }
    key.copy_from_slice(&bytes);
    Ok(key)
}

#[cfg(not(target_os = "android"))]
pub(super) fn load(base: &Path, create: bool) -> Result<Key, String> {
    use chacha20poly1305::aead::rand_core::{OsRng, RngCore};
    use sha2::{Digest, Sha256};

    let base = base.canonicalize().map_err(super::store_error)?;
    let id = Sha256::digest(base.as_os_str().as_encoded_bytes());
    let entry = keyring::Entry::new("com.carter.pax.matrix-crypto", &format!("{id:x}"))
        .map_err(vault_error)?;
    match entry.get_secret() {
        Ok(bytes) => decode(bytes),
        Err(keyring::Error::NoEntry) if create => {
            let mut key = Zeroizing::new([0; 32]);
            OsRng
                .try_fill_bytes(key.as_mut())
                .map_err(|_| "Could not generate a local Matrix store key.")?;
            entry.set_secret(key.as_ref()).map_err(vault_error)?;
            let saved = decode(entry.get_secret().map_err(vault_error)?)?;
            if *saved != *key {
                return Err("Could not verify the local Matrix store key.".into());
            }
            Ok(saved)
        }
        Err(error) => Err(vault_error(error)),
    }
}

#[cfg(not(target_os = "android"))]
fn vault_error(error: keyring::Error) -> String {
    if matches!(error, keyring::Error::NoEntry) {
        "The encrypted Matrix store key is missing from your system credential store.".into()
    } else {
        "Could not access your system credential store. Unlock it and try again.".into()
    }
}

#[cfg(target_os = "android")]
pub(crate) use android::initialize_android;
#[cfg(target_os = "android")]
pub(super) use android::load;

#[cfg(target_os = "android")]
mod android {
    use super::{decode, Key, Path};
    use jni::{
        objects::{GlobalRef, JByteArray, JClass, JValue},
        JavaVM,
    };
    use std::sync::OnceLock;

    static VAULT: OnceLock<(JavaVM, GlobalRef)> = OnceLock::new();

    pub(crate) fn initialize_android(vm: &JavaVM) -> jni::errors::Result<()> {
        let mut env = vm.get_env()?;
        let class = env.find_class("com/carter/pax/PaxStoreKey")?;
        let class = env.new_global_ref(class)?;
        let vm = env.get_java_vm()?;
        let _ = VAULT.set((vm, class));
        Ok(())
    }

    pub(in crate::crypto_store) fn load(base: &Path, create: bool) -> Result<Key, String> {
        let error = "Could not open the Matrix store key in Android Keystore.";
        let (vm, class) = VAULT.get().ok_or(error)?;
        let mut env = vm.attach_current_thread().map_err(|_| error)?;
        let path = base.join("matrix-crypto-key.enc");
        let path = env
            .new_string(path.to_str().ok_or(error)?)
            .map_err(|_| error)?;
        let result = env.call_static_method(
            <&JClass>::from(class.as_obj()),
            "open",
            "(Ljava/lang/String;Z)[B",
            &[JValue::Object(&path), JValue::Bool(u8::from(create))],
        );
        let result = match result {
            Ok(value) => value.l().map_err(|_| error)?,
            Err(_) => {
                let _ = env.exception_clear();
                return Err(error.into());
            }
        };
        if result.is_null() {
            return Err("The encrypted Matrix store key is missing from Android Keystore.".into());
        }
        decode(
            env.convert_byte_array(JByteArray::from(result))
                .map_err(|_| error)?,
        )
    }
}
