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

# Not a new vault. hmcts/shared-platform-services-infra already provisions
# kvspsplatformsbox (in rg-sps-platform-sbox) as the one shared Key Vault for
# every component of this product, with DTS AMp Developers already granted
# access there - a second, component-owned vault here would just duplicate
# that. See that repo's components/core/main.tf for how it's set up.
#
# TODO: confirm with Platform Operations that whatever identity runs this
# repo's own Jenkins pipeline actually has a data-plane role (Key Vault
# Secrets Officer or Administrator) on kvspsplatformsbox, not just the
# Contributor/Reader role shared-platform-services-infra's own
# amp_role_assignment grants at the resource group scope - Contributor does
# not include Key Vault data-plane actions under RBAC authorization, so this
# secret write may still fail at apply time until that's confirmed/granted.
data "azurerm_key_vault" "platform" {
  name                = "kvspsplatformsbox"
  resource_group_name = "rg-sps-platform-sbox"
}

resource "azurerm_key_vault_secret" "database_url" {
  name  = "DATABASE-URL"
  value = "postgresql://${module.postgresql.username}:${module.postgresql.password}@${module.postgresql.fqdn}:5432/amp_auth?sslmode=require"

  key_vault_id = data.azurerm_key_vault.platform.id
}

# JWT_SECRET, ENTRA_TENANT_ID, ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET are
# deliberately not set here. JWT_SECRET should be a random value generated
# once by hand, per the secrets-management docs' "write secrets via CLI, not
# the Azure portal" convention - not something Terraform should generate and
# hold in state. The ENTRA_* values live in the external-entra-id sbox
# tenant's own Key Vault (kvspsextidsbox); copy them into this vault by hand
# once that PR has applied - see the hmcts-api-marketplace-auth README for
# the exact secret names.
