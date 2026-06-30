require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', '..', '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoBackgroundKeepalive'
  s.version        = package['version']
  s.summary        = 'A module to keep iOS alive in background using silent audio'
  s.description    = 'A module to keep iOS alive in background using silent audio'
  s.license        = package['license'] || 'MIT'
  s.author         = package['author'] || 'Lomorage'
  s.homepage       = package['homepage'] || 'https://lomorage.com'
  s.platform       = :ios, '13.0'
  s.swift_version  = '5.4'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
