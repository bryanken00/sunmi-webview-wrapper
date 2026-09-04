package woyou.aidlservice.jiuiv5;

/**
 * Result callback for the Sunmi print service. Copied verbatim from the
 * official interface — method order defines transaction codes, do not reorder.
 */
interface ICallback {

	/**
	* Whether the call succeeded. Note: this reports that the *call* was
	* accepted, not that the paper actually came out.
	*/
	oneway void onRunResult(boolean isSuccess);

	/**
	* String result (e.g. printed length in mm since power-on).
	*/
	oneway void onReturnString(String result);

	/**
	* Failure detail: code + description.
	*/
	oneway void  onRaiseException(int code, String msg);

	/**
	* Printer result: code 0 success, 1 failure.
	*/
	oneway void  onPrintResult(int code, String msg);

}
