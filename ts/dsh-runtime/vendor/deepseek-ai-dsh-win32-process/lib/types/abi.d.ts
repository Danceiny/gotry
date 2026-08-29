/** Generic Win32 process, stdio, and Job Object constants verified on x64. */
/** STARTUPINFOW uses the standard input, output, and error handles. */
export declare const STARTF_USESTDHANDLES = 256;
/** HandleInformation flag that permits child inheritance. */
export declare const HANDLE_FLAG_INHERIT = 1;
/** Infinite WaitForSingleObject timeout. */
export declare const INFINITE = 4294967295;
/** CreateProcess flag that prevents user code from running before resume. */
export declare const CREATE_SUSPENDED = 4;
/** GetStdHandle selector for standard input. */
export declare const STD_INPUT_HANDLE = -10;
/** GetStdHandle selector for standard output. */
export declare const STD_OUTPUT_HANDLE = -11;
/** GetStdHandle selector for standard error. */
export declare const STD_ERROR_HANDLE = -12;
/** FormatMessage reads the operating system message table. */
export declare const FORMAT_MESSAGE_FROM_SYSTEM = 4096;
/** FormatMessage leaves insertion placeholders uninterpreted. */
export declare const FORMAT_MESSAGE_IGNORE_INSERTS = 512;
/** Win32 code reporting a caller-provided buffer is too small. */
export declare const ERROR_INSUFFICIENT_BUFFER = 122;
/** Win32 code reporting that the other pipe end closed. */
export declare const ERROR_BROKEN_PIPE = 109;
/** Win32 code reporting that a pipe has no remaining data. */
export declare const ERROR_NO_DATA = 232;
/** Job limit that terminates every member when the final Job handle closes. */
export declare const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 8192;
/** SetInformationJobObject class for JOBOBJECT_EXTENDED_LIMIT_INFORMATION. */
export declare const JobObjectExtendedLimitInformation = 9;
/** x64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION byte size. */
export declare const JOBOBJECT_EXTENDED_LIMIT_SIZE = 144;
/** Byte offset of BasicLimitInformation.LimitFlags in the extended Job record. */
export declare const JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET = 16;
/** x64 STARTUPINFOW byte size verified by the native probe. */
export declare const STARTUPINFOW_SIZE = 104;
/** x64 PROCESS_INFORMATION byte size verified by the native probe. */
export declare const PROCESS_INFORMATION_SIZE = 24;
//# sourceMappingURL=abi.d.ts.map