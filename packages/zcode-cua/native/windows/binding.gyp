{
  "targets": [
    {
      "target_name": "ax_native",
      "sources": [
        "src/ax_module.cc",
        "src/ax_common.cc",
        "src/ax_host_info.cc",
        "src/ax_peer.cc",
        "src/ax_pipe_server.cc"
      ],
      "include_dirs": [
        "include"
      ],
      "defines": [
        "NAPI_VERSION=8",
        "_WIN32_WINNT=0x0A00",
        "WINVER=0x0A00",
        "NTDDI_VERSION=0x0A000008",
        "WIN32_LEAN_AND_MEAN",
        "NOMINMAX",
        "UNICODE",
        "_UNICODE"
      ],
      "cflags_cc": [
        "/std:c++20",
        "/EHsc",
        "/utf-8",
        "/W4"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 2,
          "RuntimeLibrary": 2,
          "AdditionalOptions": [
            "/std:c++20",
            "/EHsc",
            "/utf-8",
            "/W4"
          ]
        }
      },
      "libraries": [
        "-ladvapi32.lib",
        "-lole32.lib",
        "-luser32.lib",
        "-lwtsapi32.lib",
        "-lntdll.lib",
        "-lwindowsapp.lib"
      ],
      "conditions": [
        [
          "OS=='win'",
          {
            "msvs_toolset": "v143"
          }
        ]
      ]
    }
  ]
}
