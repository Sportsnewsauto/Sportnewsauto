from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_environment: str = "development"
    allowed_origins: list[str] = []

    # Production secrets must be supplied through the hosting secret manager.
    # Never commit real values or user API credentials to this repository.
    database_url: str = ""
    session_secret: str = ""
    credential_encryption_key: str = ""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
