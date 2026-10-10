import Foundation
import Security
let data = FileHandle.standardInput.readDataToEndOfFile()
let args = try JSONSerialization.jsonObject(with:data) as! [String:String]
let name=args["name"]!
let query:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"jp.coursecue.local",kSecAttrAccount as String:name]
if args["op"] == "get" {
 var q=query;q[kSecReturnData as String]=true;q[kSecMatchLimit as String]=kSecMatchLimitOne
 var value:CFTypeRef?;let status=SecItemCopyMatching(q as CFDictionary,&value)
 if status != errSecSuccess { exit(2) }
 FileHandle.standardOutput.write(value as! Data)
} else {
 let value=args["value"]!.data(using:.utf8)!
 let status=SecItemUpdate(query as CFDictionary,[kSecValueData as String:value] as CFDictionary)
 if status==errSecItemNotFound {var q=query;q[kSecValueData as String]=value;q[kSecAttrAccessible as String]=kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;if SecItemAdd(q as CFDictionary,nil) != errSecSuccess {exit(3)}} else if status != errSecSuccess {exit(3)}
}
