variable "product" {
}

variable "component" {
}

variable "location" {
  default = "UK South"
}

variable "env" {
}

variable "tenant_id" {}

variable "jenkins_AAD_objectId" {
  description = "(Required) The Azure AD object ID of a user, service principal or security group in the Azure Active Directory tenant for the vault. The object ID must be unique for the list of access policies."
}

variable "subscription" {}

variable "common_tags" {
  type = map(string)
}

variable "pgsql_version" {
  description = "The version of PostgreSQL Flexible Server to use."
  type        = string
  default     = "16"
}

variable "pgsql_create_mode" {
  description = "The creation mode which can be used to restore or replicate existing servers. Possible values are Default, PointInTimeRestore, Replica and Update."
  type        = string
  default     = "Default"
}

variable "product_group_object_id" {
  description = "Object ID of the AAD group for the product team (DTS AMp Developers), granted Key Vault access by cnp-module-key-vault. TODO: fill in with the real group object ID before this can apply - not yet known in this environment."
  type        = string
}

variable "aks_subscription_id" {
  description = "Subscription ID of the AKS/CFT vnet the Postgres Flexible Server injects into. Provided automatically by the Jenkins library in a real pipeline run; set explicitly here for local plan/apply. TODO: not yet known in this environment - get the correct sandbox subscription ID from Platform Operations rather than guessing one."
  type        = string
}
