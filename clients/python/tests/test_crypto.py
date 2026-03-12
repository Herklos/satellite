"""Tests for client-side encryption."""

from satellite_sdk.crypto import Encryptor, ENCRYPTED_KEY


def test_round_trip():
    enc = Encryptor("test-secret", "test-salt")
    data = {"hello": "world", "num": 42}

    encrypted = enc.encrypt(data)
    assert ENCRYPTED_KEY in encrypted
    assert isinstance(encrypted[ENCRYPTED_KEY], str)

    decrypted = enc.decrypt(encrypted)
    assert decrypted == data


def test_decrypt_unencrypted_passthrough():
    enc = Encryptor("test-secret", "test-salt")
    plain = {"plain": "data"}

    result = enc.decrypt(plain)
    assert result == plain


def test_different_secrets():
    enc1 = Encryptor("secret-1", "salt")
    enc2 = Encryptor("secret-2", "salt")
    data = {"key": "value"}

    encrypted = enc1.encrypt(data)
    try:
        enc2.decrypt(encrypted)
        assert False, "Should have raised"
    except Exception:
        pass


def test_different_salts():
    enc1 = Encryptor("secret", "salt-1")
    enc2 = Encryptor("secret", "salt-2")
    data = {"key": "value"}

    encrypted = enc1.encrypt(data)
    try:
        enc2.decrypt(encrypted)
        assert False, "Should have raised"
    except Exception:
        pass


def test_custom_info():
    enc = Encryptor("secret", "salt", info="custom-info")
    data = {"custom": True}

    encrypted = enc.encrypt(data)
    decrypted = enc.decrypt(encrypted)
    assert decrypted == data
