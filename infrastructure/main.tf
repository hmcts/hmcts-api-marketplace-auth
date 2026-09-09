provider "azurerm" {
  features {}
}

provider "azurerm" {
  features {}
  subscription_id            = var.aks_subscription_id
  skip_provider_registration = true
  alias                      = "postgres_network"
}

resource "azurerm_resource_group" "rg" {
  name     = "${var.product}-${var.component}-${var.env}"
  location = var.location

  tags = var.common_tags
}

# amp-auth reads a single DATABASE_URL connection string (see src/db.js),
# not separate host/user/pass/port vars - so only one secret is stored below,
# composed from this module's outputs, rather than draft-store's five.
module "postgresql" {
  providers = {
    azurerm.postgres_network = azurerm.postgres_network
  }

  source = "git@github.com:hmcts/terraform-module-postgresql-flexible?ref=master"
  env    = var.env

  product       = var.product
  component     = var.component
  business_area = "cft"

  pgsql_databases = [
    {
      name : "amp_auth"
    }
  ]

  pgsql_version = var.pgsql_version
  create_mode   = var.pgsql_create_mode

  admin_user_object_id = var.jenkins_AAD_objectId

  common_tags = var.common_tags
}

# Product-level vault, shared with any other amp-* component - matches the
# {product}-{env} naming convention documented at
# hmcts.github.io/cloud-native-platform/new-component/secrets-management.html.
module "key-vault" {
  source              = "git@github.com:hmcts/cnp-module-key-vault?ref=master"
  product             = var.product
  env                 = var.env
  tenant_id           = var.tenant_id
  object_id           = var.jenkins_AAD_objectId
  resource_group_name = azurerm_resource_group.rg.name

  product_group_name       = "DTS AMp Developers"
  product_group_object_id  = var.product_group_object_id
  common_tags              = var.common_tags
}

resource "azurerm_key_vault_secret" "database_url" {
  name  = "DATABASE-URL"
  value = "postgresql://${module.postgresql.username}:${module.postgresql.password}@${module.postgresql.fqdn}:5432/amp_auth?sslmode=require"

  key_vault_id = module.key-vault.key_vault_id
}

# JWT_SECRET, ENTRA_TENANT_ID, ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET are
# deliberately not set here. JWT_SECRET should be a random value generated
# once by hand, per the secrets-management docs' "write secrets via CLI, not
# the Azure portal" convention - not something Terraform should generate and
# hold in state. The ENTRA_* values live in the external-entra-id sbox
# tenant's own Key Vault (kvspsextidsbox); copy them into this vault by hand
# once that PR has applied - see the hmcts-api-marketplace-auth README for
# the exact secret names.
