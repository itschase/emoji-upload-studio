import crypto from 'node:crypto'
const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519')
console.log(JSON.stringify({stateSecret:crypto.randomBytes(32).toString('base64url'),signingPrivateJwk:privateKey.export({format:'jwk'}),signingPublicJwk:publicKey.export({format:'jwk'})},null,2))
